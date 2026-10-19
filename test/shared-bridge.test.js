import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSharedBridge } from '../bridge/shared-server.js';
import { createBridgeHttp } from '../bridge/http.js';
import { BrowserHub } from '../bridge/hub.js';
import { SharedBrowserHub } from '../bridge/shared-client.js';
import { ensureSharedDaemon, sharedStatus } from '../bridge/shared-process.js';
import { ensureConfig } from '../bridge/config.js';
import { registerBrowserTools } from '../bridge/tools.js';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import { repositoryRoot } from '../scripts/installation.js';

const token = 'a'.repeat(64);
const origin = `chrome-extension://${'b'.repeat(32)}`;

async function fixture(t) {
  const bridge = createSharedBridge({ token, port: 0 }, { version: 'test' });
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const config = { token, port: bridge.server.address().port };
  return { ...bridge, config, url: `http://127.0.0.1:${config.port}` };
}

async function browserConnection(t, config, chrome = fakeChrome(), bindings = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}/browser`, { origin });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  const browser = new SessionBrowser(chrome, (message) => ws.send(JSON.stringify(message)));
  await browser.restore(bindings);
  browser.enabled = true;
  ws.on('message', async (data) => {
    const message = JSON.parse(data);
    if (message.type === 'cancel') return browser.cancel(message);
    if (message.type !== 'command') return;
    try {
      const result = await browser.run(message);
      ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'result', id: message.id, error: error.message }));
    }
  });
  const ready = once(ws, 'message');
  ws.send(
    JSON.stringify({ type: 'hello', version: 2, token: config.token, enabled: true, bindings }),
  );
  await ready;
  return { ws, chrome, browser };
}

async function mcpClient(t, config) {
  const mcp = new McpServer({ name: 'test-shared-adapter', version: 'test' });
  registerBrowserTools(mcp, new SharedBrowserHub(config));
  const client = new Client({ name: 'test-project', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  return client;
}

function call(client, sessionID, name, args = {}, options) {
  return client.callTool(
    { name, arguments: args, _meta: { 'ai.opencode/sessionID': sessionID } },
    undefined,
    options,
  );
}

function text(result) {
  return JSON.parse(result.content[0].text);
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return;
    await setTimeout(20);
  }
  throw new Error('Test condition timed out');
}

test('independent project adapters share one browser but cannot access each other’s tabs', async (t) => {
  const f = await fixture(t);
  const { chrome } = await browserConnection(t, f.config);
  const first = await mcpClient(t, f.config);
  const second = await mcpClient(t, f.config);
  assert.equal((await first.listTools()).tools.length, 27);
  const [one, two] = await Promise.all([
    call(first, 'ses_projectOne', 'open_tab', { url: 'https://example.com' }),
    call(second, 'ses_projectTwo', 'open_tab', { url: 'https://example.org' }),
  ]);
  const tabOne = text(one).tabID;
  const tabTwo = text(two).tabID;
  assert.notEqual(tabOne, tabTwo);
  const cross = await call(first, 'ses_projectOne', 'read_page', { tabID: tabTwo });
  assert.equal(cross.isError, true);
  assert.match(cross.content[0].text, /does not own/);
  assert.equal((await call(first, 'ses_projectOne', 'close_tab', { tabID: 1 })).isError, true);
  assert.ok(chrome.tabState.has(1));
  await first.close();
  assert.equal(text(await call(second, 'ses_projectTwo', 'list_tabs')).tabs.length, 1);
  assert.ok(chrome.tabState.has(tabOne));
  assert.equal((await sharedStatus(f.config)).mode, 'shared');
  assert.equal((await call(second, 'ses_projectTwo', 'screenshot')).content[0].type, 'image');
  const missing = await second.callTool({ name: 'open_tab', arguments: {} });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /session metadata/);
});

test('shared HTTP calls require authentication and reject browser origins and invalid tools', async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify({ sessionID: 'ses_test', tool: 'list_tabs', args: {} });
  assert.equal((await fetch(f.url + '/call', { method: 'POST', body })).status, 401);
  for (const candidate of ['https://example.com', origin])
    assert.equal(
      (
        await fetch(f.url + '/call', {
          method: 'POST',
          body,
          headers: { Authorization: `Bearer ${token}`, Origin: candidate },
        })
      ).status,
      403,
    );
  for (const request of [
    { sessionID: 'ses_test', tool: 'evaluate', args: {} },
    { sessionID: 'ses_test', tool: 'click', args: { ref: 'invented' } },
    { tool: 'list_tabs', args: {} },
  ]) {
    const response = await fetch(f.url + '/call', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Invalid shared browser request.');
  }
  assert.equal((await fetch(f.url + '/shutdown', { method: 'POST' })).status, 401);
  const tooLarge = await fetch(f.url + '/call', {
    method: 'POST',
    body: 'x'.repeat(128 * 1024 + 1),
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(tooLarge.status, 400);
});

test('adapter cancellation reaches the shared browser without affecting other clients', async (t) => {
  const f = await fixture(t);
  const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/browser', { origin });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', version: 2, token, enabled: true, bindings: {} }));
  await ready;
  const client = await mcpClient(t, f.config);
  const controller = new AbortController();
  const sent = once(ws, 'message');
  const pending = call(
    client,
    'ses_cancelled',
    'click',
    { ref: 'e1' },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(pending, /abort|cancel/i);
  const [command] = await sent;
  const cancelled = once(ws, 'message');
  controller.abort();
  await rejected;
  const [data] = await cancelled;
  assert.deepEqual(JSON.parse(data), {
    type: 'cancel',
    id: JSON.parse(command).id,
    sessionID: 'ses_cancelled',
  });
  await waitFor(() => f.hub.pending.size === 0);
  assert.equal(f.hub.browserEnabled, true);
});

test('the shared daemon keeps owned tabs across browser reconnection', async (t) => {
  const f = await fixture(t);
  const { ws, chrome } = await browserConnection(t, f.config);
  const hub = new SharedBrowserHub(f.config);
  const tab = await hub.call('ses_reconnect', 'open_tab', { url: 'https://example.com' });
  const binding = f.hub.bindings.get('ses_reconnect');
  ws.terminate();
  await waitFor(() => f.hub.socket === null);
  await assert.rejects(hub.call('ses_reconnect', 'list_tabs', {}), /disconnected/);
  await browserConnection(t, f.config, chrome, { ses_reconnect: binding });
  assert.equal((await hub.call('ses_reconnect', 'list_tabs', {})).tabs[0].id, tab.tabID);
});

test('concurrent adapters start a single persistent daemon and can restart it after shutdown', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chrome-shared-process-'));
  const configURL = pathToFileURL(path.join(directory, '.local/config.json'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const config = await ensureConfig({ port }, configURL);
  const clients = [];
  const stop = async () => {
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    await waitFor(async () => (await sharedStatus(config)) === null);
  };
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const statuses = await Promise.all(
    Array.from({ length: 4 }, () => ensureSharedDaemon(config, { configURL })),
  );
  assert.equal(new Set(statuses.map((status) => status.bridgeID)).size, 1);
  for (const name of ['project-a', 'project-b']) {
    const cwd = path.join(directory, name);
    await mkdir(cwd);
    const client = new Client({ name, version: 'test' });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(repositoryRoot, 'bridge/shared-main.js'),
          '--config',
          path.join(directory, '.local/config.json'),
        ],
        cwd,
        stderr: 'pipe',
      }),
    );
    assert.equal((await client.listTools()).tools.length, 27);
  }
  await clients[0].close();
  assert.equal((await sharedStatus(config)).bridgeID, statuses[0].bridgeID);
  await stop();
  const recovering = await call(clients[1], 'ses_recovering', 'list_tabs');
  assert.equal(recovering.isError, true);
  assert.match(recovering.content[0].text, /disconnected/);
  const restarted = await sharedStatus(config);
  assert.notEqual(restarted.bridgeID, statuses[0].bridgeID);
  await clients[1].close();
  for (const name of ['project-a', 'project-b'])
    await rm(path.join(directory, name), { recursive: true, maxRetries: 10, retryDelay: 100 });
  assert.equal((await sharedStatus(config)).bridgeID, restarted.bridgeID);
});

test('global startup refuses an existing project-local bridge without disconnecting it', async (t) => {
  const hub = new BrowserHub();
  const { server, sockets } = createBridgeHttp({ token, port: 0, hub });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const config = { token, port: server.address().port };
  await browserConnection(t, config);
  const originalSocket = hub.socket;
  await assert.rejects(ensureSharedDaemon(config), /not a shared/);
  await assert.rejects(ensureSharedDaemon({ ...config, token: 'b'.repeat(64) }), /occupied/);
  assert.equal(hub.socket, originalSocket);
  assert.equal(hub.browserEnabled, true);
});
