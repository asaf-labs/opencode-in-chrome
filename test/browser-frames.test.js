import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import { startTestBrowser } from './cdp-browser.js';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

test(
  'real Chrome routes nested cross-origin iframe refs and hit-tests every containing frame',
  {
    skip: !process.env.CHROME_BINARY && 'Set CHROME_BINARY to run the isolated iframe regression.',
    timeout: 30000,
  },
  async (t) => {
    let parentURL, childURL;
    const page = createServer((req, res) => {
      const html =
        req.url === '/nested'
          ? `<div role="listbox"><div role="option" id="coupa" style="padding:10px">Coupa</div></div><input aria-label="Search portals"><span id="selected">none</span>
      <script>document.getElementById('coupa').addEventListener('click', event => { if(event.isTrusted) document.getElementById('selected').textContent='Coupa'; });</script>`
          : `<title>Frame host</title><style>iframe { width:420px;height:340px;border:5px solid black;padding:3px;margin:20px }</style><button>Parent action</button><iframe src="${childURL}"></iframe>`;
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    });
    const child = createServer((_req, res) =>
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          `<title>Cross-origin child</title><iframe src="${parentURL}/nested" style="width:280px;height:190px;border:4px solid black;transform:scale(.9);transform-origin:top left"></iframe>`,
        ),
    );
    for (const server of [page, child]) {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(
        () =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
      );
    }
    parentURL = `http://127.0.0.1:${page.address().port}`;
    childURL = `http://127.0.0.1:${child.address().port}`;
    const cdp = await startTestBrowser(t);
    await cdp.navigate(parentURL);
    const chrome = fakeChrome();
    const browser = new SessionBrowser(chrome);
    browser.enabled = true;
    chrome.scripting.executeScript = async (request) => {
      const contexts = (await cdp.contexts()).filter(
        (entry) =>
          request.target.allFrames || (request.target.frameIds || [0]).includes(entry.frameId),
      );
      if (request.files) {
        for (const entry of contexts) await cdp.evaluate(content, entry.contextID);
        return [];
      }
      const expression = `(${request.func.toString()})(...${JSON.stringify(request.args || [])})`;
      const results = [];
      for (const entry of contexts)
        results.push({
          frameId: entry.frameId,
          result: await cdp.evaluate(expression, entry.contextID),
        });
      return results;
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
      sessionID: 'ses_iframes',
      generation: browser.bindings.ses_iframes?.generation || 'generation',
      expiresAt: Date.now() + 25000,
    });
    await browser.run(command('open_tab', { url: parentURL }));
    const snapshot = await browser.run(command('read_page'));
    assert.equal(snapshot.frames.length, 3);
    const coupa = snapshot.elements.find((element) => element.label === 'Coupa');
    assert.match(coupa.ref, /^f\d+:e\d+$/);
    const search = snapshot.elements.find((element) => element.label === 'Search portals');
    await browser.run(command('type', { ref: search.ref, text: 'Coupa' }));
    const clicked = await browser.run(command('click', { ref: coupa.ref }));
    assert.equal(clicked.frameID, coupa.frameID);
    const nestedContext = (await cdp.contexts()).find(
      (entry) => entry.frameId === coupa.frameID,
    ).contextID;
    assert.equal(
      await cdp.evaluate("document.getElementById('selected').textContent", nestedContext),
      'Coupa',
    );
    const isolated = await browser.run(command('read_page', { frameID: coupa.frameID }));
    assert.equal(isolated.frameID, coupa.frameID);
    assert.equal(
      isolated.elements.some((element) => element.label === 'Parent action'),
      false,
    );

    await cdp.evaluate(
      `const cover = document.createElement('div'); cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; document.body.append(cover);`,
    );
    const fresh = await browser.run(command('read_page'));
    const before = chrome.debuggerCalls.length;
    await assert.rejects(
      browser.run(
        command('click', { ref: fresh.elements.find((element) => element.label === 'Coupa').ref }),
      ),
      /Containing iframe.*covered/,
    );
    assert.equal(chrome.debuggerCalls.length, before);
  },
);
