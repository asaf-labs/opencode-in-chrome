import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import { startTestBrowser } from './cdp-browser.js';

const performanceSource = await readFile(
  new URL('../extension/performance-capture.js', import.meta.url),
  'utf8',
);
test(
  'real Chrome captures network bodies, console errors, CPU samples and tab-scoped performance events',
  {
    skip: !process.env.CHROME_BINARY && 'Set CHROME_BINARY for the isolated inspection regression.',
    timeout: 30000,
  },
  async (t) => {
    const server = createServer((req, res) => {
      if (req.url === '/api') {
        res
          .writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=private' })
          .end('{"token":"private","answer":42}');
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<!doctype html><title>Inspection sandbox</title><h1>Local inspection test</h1>');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const cdp = await startTestBrowser(t),
      url = `http://127.0.0.1:${server.address().port}`;
    await cdp.navigate(url);
    const chrome = fakeChrome(),
      browser = new SessionBrowser(chrome);
    browser.enabled = true;
    chrome.debugger.sendCommand = (_target, method, params) => cdp.command(method, params);
    cdp.onAnyEvent((method, params) => chrome.emitDebugger(100, method, params));
    chrome.scripting.executeScript = async (request) => {
      const contextID = await cdp.context();
      if (request.files) {
        await cdp.evaluate(performanceSource, contextID);
        return [];
      }
      return [
        {
          result: await cdp.evaluate(
            `(${request.func.toString()})(...${JSON.stringify(request.args || [])})`,
            contextID,
          ),
        },
      ];
    };
    const command = (tool, args = {}) => ({
      tool,
      args,
      sessionID: 'ses_realInspection',
      id: crypto.randomUUID(),
      generation: browser.bindings.ses_realInspection?.generation || 'generation',
      expiresAt: Date.now() + 25000,
    });
    const { tabID } = await browser.run(command('open_tab', { url }));
    t.after(() => browser.suspend());
    await browser.run(command('start_inspection', { tabID, captureBodies: true }));
    await browser.run(command('start_cpu_profile', { tabID, durationMs: 10000 }));
    await browser.run(command('start_performance_trace', { tabID, durationMs: 10000 }));
    await cdp.evaluate(`(async () => {
    console.log('inspection-ready'); console.warn('token=private');
    performance.mark('work-start');
    function demoWork() { const start = performance.now(); while (performance.now() - start < 150) Math.sqrt(Math.random()); }
    demoWork(); performance.mark('work-end'); performance.measure('demo-work', 'work-start', 'work-end');
    await fetch('/api', {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer private'},body:JSON.stringify({password:'private',value:42})});
    setTimeout(() => { throw new Error('demo-error'); }, 0);
  })()`);
    await cdp.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
    const { requests } = await browser.run(
      command('network_requests', { tabID, urlContains: '/api' }),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].statusCode, 200);
    assert.equal(requests[0].state, 'completed');
    const row = await browser.run(
      command('network_request', { tabID, requestID: requests[0].id, includeBody: true }),
    );
    assert.equal(row.responseBody.state, 'text');
    assert.ok(row.responseBody.text.includes('42'));
    assert.equal(JSON.stringify(row).includes('private'), false);
    const logs = await browser.run(command('console_logs', { tabID }));
    assert.ok(logs.messages.some((message) => message.text.includes('inspection-ready')));
    assert.ok(
      logs.messages.some(
        (message) => message.level === 'error' && message.text.includes('demo-error'),
      ),
    );
    assert.equal(JSON.stringify(logs).includes('private'), false);
    const cpu = await browser.run(command('stop_cpu_profile', { tabID }));
    assert.ok(cpu.data.samples.length > 0);
    assert.ok(cpu.data.nodes.some((node) => node.callFrame.functionName === 'demoWork'));
    const timeline = await browser.run(command('stop_performance_trace', { tabID }));
    assert.ok(timeline.data.traceEvents.some((event) => event.name === 'demo-work'));
    assert.equal(timeline.data.metadata.source, 'main-frame-performance-observer');
    await browser.run(command('stop_inspection', { tabID }));
    assert.equal(chrome.debuggerTabs.size, 0);
  },
);
