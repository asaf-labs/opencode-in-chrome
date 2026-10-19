import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BrowserHub } from '../bridge/hub.js';
import { createBridgeHttp } from '../bridge/http.js';
import { registerBrowserTools } from '../bridge/tools.js';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';

const token = 'a'.repeat(64),
  origin = `chrome-extension://${'b'.repeat(32)}`;
async function fixture(t) {
  const hub = new BrowserHub();
  const { server, sockets } = createBridgeHttp({ token, port: 0, hub });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const http = (path, headers = {}) =>
    fetch(url + path, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  const connect = async (candidate = token, version = 2) => {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/browser', { origin });
    await once(ws, 'open');
    const response = once(ws, candidate === token ? 'message' : 'close');
    ws.send(
      JSON.stringify({ type: 'hello', version, token: candidate, enabled: true, bindings: {} }),
    );
    await response;
    return ws;
  };
  return { hub, http, connect, url };
}

test('HTTP requires a token and rejects website origins; chat endpoints are removed', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + '/status')).status, 401);
  assert.equal((await f.http('/status', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await f.http('/status', { Origin: origin })).status, 200);
  assert.equal((await f.http('/sessions')).status, 404);
});

test('invalid WebSocket token cannot replace an authenticated browser', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const attached = f.hub.socket;
  const invalid = await f.connect('wrong');
  assert.equal(invalid.readyState, WebSocket.CLOSED);
  assert.equal(f.hub.socket, attached);
});

test('real MCP creates tabs for new sessions automatically and enforces session ownership end to end', async (t) => {
  const f = await fixture(t),
    ws = await f.connect();
  const chrome = fakeChrome();
  const browser = new SessionBrowser(chrome, (message) => ws.send(JSON.stringify(message)));
  browser.enabled = true;
  ws.on('message', async (data) => {
    const message = JSON.parse(data);
    if (message.type !== 'command') return;
    try {
      const result = await browser.run(message);
      ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'result', id: message.id, error: error.message }));
    }
  });
  const mcp = new McpServer({ name: 'test-chrome', version: '1.0.0' });
  registerBrowserTools(mcp, f.hub);
  const client = new Client({ name: 'test-opencode', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 27);
  const call = (sessionID, name, args = {}) =>
    client.callTool({ name, arguments: args, _meta: { 'ai.opencode/sessionID': sessionID } });
  const text = (result) => JSON.parse(result.content[0].text);
  assert.equal(text(await call('ses_one', 'list_tabs')).tabs.length, 0);
  const first = text(await call('ses_one', 'open_tab', { url: 'https://example.com' }));
  const second = text(await call('ses_two', 'open_tab', { url: 'https://example.org' }));
  assert.notEqual(first.tabID, second.tabID);
  assert.equal(text(await call('ses_one', 'list_tabs')).tabs.length, 1);
  assert.equal(
    text(await call('ses_one', 'read_page', { tabID: first.tabID })).title,
    'Agent page',
  );
  const cross = await call('ses_one', 'read_page', { tabID: second.tabID });
  assert.equal(cross.isError, true);
  assert.match(cross.content[0].text, /does not own/);
  const personal = await call('ses_one', 'close_tab', { tabID: 1 });
  assert.equal(personal.isError, true);
  assert.ok(chrome.tabState.has(1));
  const image = await call('ses_two', 'screenshot');
  assert.equal(image.content[0].type, 'image');
  assert.equal(image.content[0].mimeType, 'image/png');
  await call('ses_one', 'close_tab', { tabID: first.tabID });
  assert.equal(text(await call('ses_one', 'list_tabs')).tabs.length, 0);
  assert.ok(chrome.tabState.has(second.tabID));
  const missing = await client.callTool({ name: 'open_tab', arguments: {} });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /session metadata/);
});

test('malformed authenticated handshake cannot evict a working browser connection', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const attached = f.hub.socket;
  const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/browser', { origin });
  await once(ws, 'open');
  const closed = once(ws, 'close');
  ws.send(
    JSON.stringify({
      type: 'hello',
      version: 2,
      token,
      enabled: true,
      bindings: { ses_bad: { tabs: [null], generation: 'invalid' } },
    }),
  );
  const [code] = await closed;
  assert.equal(code, 4002);
  assert.equal(f.hub.socket, attached);
  assert.equal(f.hub.browserEnabled, true);
});

test('disabling access rejects pending browser work and prevents future tabs', async (t) => {
  const f = await fixture(t),
    ws = await f.connect();
  const sent = once(ws, 'message');
  const pending = f.hub.call('ses_one', 'open_tab', {});
  const rejected = assert.rejects(pending, /disabled/);
  await sent;
  ws.send(JSON.stringify({ type: 'availability', enabled: false }));
  await rejected;
  await assert.rejects(f.hub.call('ses_one', 'open_tab', {}), /enable browser/);
  assert.equal(f.hub.activity.at(-1).status, 'error');
});

test('old extension connections cannot use the new ownership protocol', async (t) => {
  const f = await fixture(t);
  await f.connect(token, 1);
  await assert.rejects(f.hub.call('ses_one', 'open_tab', {}), /old extension/);
});

test('tab-list updates preserve pending requests; generation changes invalidate them', async (t) => {
  const f = await fixture(t),
    ws = await f.connect();
  const command = once(ws, 'message');
  const pending = f.hub.call('ses_one', 'open_tab', {});
  const rejection = assert.rejects(pending, /session changed/);
  const [data] = await command,
    message = JSON.parse(data);
  f.hub.bind('ses_one', { tabs: [{ id: 100 }], generation: message.generation });
  assert.equal(f.hub.pending.size, 1);
  f.hub.bind('ses_one', { tabs: [{ id: 100 }], generation: 'new-generation' });
  await rejection;
  f.hub.receive({ type: 'result', id: message.id, result: { ok: true } });
  assert.equal(f.hub.pending.size, 0);
});

test('MCP cancellation is forwarded to the browser and late results are ignored', async (t) => {
  const f = await fixture(t),
    ws = await f.connect(),
    controller = new AbortController();
  const sent = once(ws, 'message');
  const pending = f.hub.call('ses_one', 'click', { ref: 'e1' }, controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  const [data] = await sent;
  const command = JSON.parse(data);
  const cancelled = once(ws, 'message');
  controller.abort();
  const [cancelData] = await cancelled;
  assert.deepEqual(JSON.parse(cancelData), {
    type: 'cancel',
    id: command.id,
    sessionID: 'ses_one',
  });
  await rejected;
  f.hub.receive({ type: 'result', id: command.id, result: { ok: true } });
  assert.equal(f.hub.pending.size, 0);
});
