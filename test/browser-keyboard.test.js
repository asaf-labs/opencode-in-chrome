import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import { startTestBrowser } from './cdp-browser.js';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const html = `<!doctype html><title>Canvas grid keyboard sandbox</title>
<label>Name box<input id="name" value="B1"></label>
<canvas id="grid" role="grid" aria-label="Demo sheet" tabindex="0" width="500" height="200"></canvas>
<iframe id="frame" src="/editor" style="position:absolute;opacity:0;width:1px;height:1px"></iframe>
<pre id="state">A1=Original;B1=</pre>
<script>
window.cells={A1:'Original',B1:''}; window.current='B1'; window.inputs=[]; window.keys=[];
window.commit=text=>{ cells[current]=text; document.getElementById('state').textContent='A1='+cells.A1+';B1='+cells.B1; };
function edit(){const child=document.getElementById('frame').contentWindow;child.document.body.textContent=cells[current];child.focus();child.document.body.focus();}
document.getElementById('grid').onclick=edit;
document.getElementById('name').onkeydown=event=>{ if(event.key==='Enter'){event.preventDefault();current=event.target.value;edit();} };
</script>`;
const editor = `<!doctype html><body contenteditable="true" aria-label="Grid editor"><script>
document.body.addEventListener('input',event=>parent.inputs.push({trusted:event.isTrusted,type:event.inputType}));
document.body.addEventListener('keydown',event=>{parent.keys.push({key:event.key,trusted:event.isTrusted});if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();parent.commit(document.body.innerText);}});
</script>`;

test(
  'real Chrome trusted keys and Unicode input edit a canvas grid through its focused iframe editor',
  {
    skip: !process.env.CHROME_BINARY && 'Set CHROME_BINARY for the isolated keyboard regression.',
    timeout: 40000,
  },
  async (t) => {
    const server = createServer((req, res) =>
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(req.url === '/editor' ? editor : html),
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
    await cdp.navigate(url);
    await cdp.command('Page.bringToFront');
    const chrome = fakeChrome(),
      browser = new SessionBrowser(chrome);
    browser.enabled = true;
    chrome.scripting.executeScript = async (request) => {
      const contexts = (await cdp.contexts()).filter(
        (context) =>
          request.target.allFrames || (request.target.frameIds || [0]).includes(context.frameId),
      );
      return Promise.all(
        contexts.map(async (context) => {
          if (request.files) {
            await cdp.evaluate(content, context.contextID);
            return { frameId: context.frameId };
          }
          return {
            frameId: context.frameId,
            result: await cdp.evaluate(
              `(${request.func.toString()})(...${JSON.stringify(request.args || [])})`,
              context.contextID,
            ),
          };
        }),
      );
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
      sessionID: 'ses_keyboard',
      generation: browser.bindings.ses_keyboard?.generation || 'g',
      expiresAt: Date.now() + 25000,
    });
    t.after(() => browser.suspend());
    await browser.run(command('open_tab', { url }));
    let snapshot = await browser.run(command('read_page'));
    const grid = snapshot.elements.find((element) => element.type === 'grid');
    assert.ok(grid);
    await browser.run(command('click', { ref: grid.ref }));
    snapshot = await browser.run(command('read_page'));
    assert.notEqual(snapshot.focus.frameID, 0);
    assert.equal(snapshot.focus.editable, true);
    const act = async (tool, args) => {
      const before = await browser.run(command('read_page'));
      assert.ok(before.focus);
      return browser.run(command(tool, { ...args, focusToken: before.focus.token }));
    };
    const firstToken = snapshot.focus.token;
    await act('insert_text', { text: 'Overview שלום 🌍' });
    const calls = chrome.debuggerCalls.length;
    await assert.rejects(
      browser.run(command('press_key', { key: 'Enter', focusToken: firstToken })),
      /token expired/,
    );
    assert.equal(chrome.debuggerCalls.length, calls);
    await act('press_key', { key: 'Enter' });
    assert.equal(await cdp.evaluate('cells.B1'), 'Overview שלום 🌍');
    assert.equal(await cdp.evaluate('cells.A1'), 'Original');
    await act('press_key', { key: 'Control+a' });
    await act('insert_text', { text: 'Details' });
    await act('press_key', { key: 'Tab' });
    assert.equal(await cdp.evaluate('cells.B1'), 'Details');
    assert.equal(await cdp.evaluate('cells.A1'), 'Original');
    const fresh = await browser.run(command('read_page'));
    await cdp.evaluate("document.getElementById('name').focus()");
    const beforeLostFocus = chrome.debuggerCalls.length;
    await assert.rejects(
      browser.run(command('insert_text', { text: 'Not sent', focusToken: fresh.focus.token })),
      /focus changed/,
    );
    assert.equal(chrome.debuggerCalls.length, beforeLostFocus);
    assert.equal(await cdp.evaluate("document.getElementById('name').value"), 'B1');
    assert.equal(await cdp.evaluate('inputs.every(event=>event.trusted)'), true);
    assert.ok((await cdp.evaluate('inputs.length')) >= 2);
    assert.equal(await cdp.evaluate('keys.every(event=>event.trusted)'), true);
    await browser.suspend();
    assert.equal(chrome.debuggerTabs.size, 0);
  },
);
