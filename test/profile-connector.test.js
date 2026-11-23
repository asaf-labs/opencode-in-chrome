import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProfileHub, createProfileHub } from '../bridge/profiles.js';
import { ProfileConnector } from '../bridge/profile-connector.js';
import { writePrivateJSON } from '../bridge/private-store.js';
import { readProfileState } from '../bridge/profile-store.js';
import { createSharedBridge } from '../bridge/shared-server.js';
import { SharedBrowserHub } from '../bridge/shared-client.js';
import { browserToolDefinitions, registerBrowserTools } from '../bridge/tools.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const token = 'a'.repeat(64);

function socket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.close = () => {
    ws.readyState = 3;
    ws.emit('close');
  };
  return ws;
}

function fixture({ enabled = true, ...options } = {}) {
  let clock = 0,
    launches = 0,
    loads = 0;
  const hub = new ProfileHub({
    state: {
      profiles: [
        { id: first, name: 'First', ...(enabled === undefined ? {} : { enabled }) },
        { id: second, name: 'Other', enabled: true },
      ],
      selections: { ses_first: second },
    },
  });
  const connector = new ProfileConnector(hub, {
    now: () => clock,
    grace: 10,
    timeout: 500,
    delay: async (ms, _, { signal }) => {
      if (signal.aborted) throw new Error('Aborted');
      clock += ms;
    },
    load: async () => {
      loads++;
      return { profiles: { [first]: { approved: true } } };
    },
    resolve: async (mapping) => mapping,
    launch: async () => {
      launches++;
      hub.attach(socket(), true, 3, { id: first, name: 'First' });
    },
    ...options,
  });
  hub.connector = connector;
  return {
    hub,
    connector,
    launches: () => launches,
    loads: () => loads,
    setClock: (value) => {
      clock = value;
    },
  };
}

test('connect_profile schema accepts only explicit profile identity, never paths, commands or URLs', () => {
  const definition = browserToolDefinitions.find(([name]) => name === 'connect_profile');
  const schema = z.object(definition[2]).strict();
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ profileID: first }).success, true);
  for (const args of [
    { executable: 'chrome' },
    { profilePath: 'Profile 1' },
    { url: 'https://example.com' },
    { args: ['--incognito'] },
  ])
    assert.equal(schema.safeParse({ profileID: first, ...args }).success, false);
});

test('an enabled connected profile returns immediately without loading launch paths or changing account selection', async () => {
  const f = fixture();
  const ws = socket();
  f.hub.attach(ws, true, 3, { id: first, name: 'First' });
  const result = await f.hub.call('ses_first', 'connect_profile', { profileID: first });
  assert.equal(result.connected, true);
  assert.equal(result.launched, false);
  assert.equal(result.selectedProfileID, second);
  assert.equal(f.loads(), 0);
  assert.equal(f.launches(), 0);
  assert.equal(f.hub.profiles.get(first).hub.bindings.size, 0);
});

test('a launch connects only the requested authenticated identity and never selects or adopts tabs', async () => {
  const f = fixture();
  const result = await f.hub.call('ses_first', 'connect_profile', { profileID: first });
  assert.equal(result.connected, true);
  assert.equal(result.launched, true);
  assert.equal(result.profileID, first);
  assert.equal(result.selectedProfileID, second);
  assert.equal(f.launches(), 1);
  assert.equal(f.hub.profiles.get(first).hub.bindings.size, 0);
  assert.equal(f.hub.profiles.get(second).hub.socket, null);
  assert.equal(f.hub.inFlight.size, 0);
});

test('unknown, legacy, disabled and unconfirmed profiles never launch; missing or invalid mappings fail closed', async () => {
  for (const enabled of [false, undefined]) {
    const f = fixture({ enabled });
    if (enabled === undefined) delete f.hub.profiles.get(first).enabled;
    await assert.rejects(f.connector.connect(first), /disabled|unknown/);
    assert.equal(f.launches(), 0);
    assert.equal(f.loads(), 0);
  }
  const f = fixture();
  await assert.rejects(f.connector.connect(crypto.randomUUID()), /registered profile/);
  await assert.rejects(f.connector.connect('legacy'), /registered profile/);
  f.hub.attach(socket(), false, 3, { id: first, name: 'First' });
  await assert.rejects(f.connector.connect(first), /disabled/);
  assert.equal(f.launches(), 0);
  const missing = fixture({ load: async () => ({ profiles: {} }) });
  await assert.rejects(missing.connector.connect(first), /profile:map/);
  const invalid = fixture({
    resolve: async () => {
      throw new Error('secret user profile path');
    },
  });
  await assert.rejects(
    invalid.connector.connect(first),
    (error) => !error.message.includes('secret user'),
  );
});

test('a different profile reconnecting cannot satisfy the wait, and repeated timeouts do not spam windows', async () => {
  let launched = 0;
  const f = fixture({
    launch: async () => {
      launched++;
      f.hub.attach(socket(), true, 3, { id: second, name: 'Other' });
    },
  });
  await assert.rejects(f.connector.connect(first), /requested profile did not reconnect/);
  assert.equal(launched, 1);
  assert.equal(f.hub.selections.get('ses_first'), second);
  await assert.rejects(f.connector.connect(first), /already launched/);
  assert.equal(launched, 1);
});

test('passive reconnection avoids launching, and a disabled handshake never gets enabled', async () => {
  const passive = fixture({
    delay: async () => {
      passive.hub.attach(socket(), true, 3, { id: first, name: 'First' });
    },
  });
  assert.equal((await passive.connector.connect(first)).launched, false);
  assert.equal(passive.loads(), 0);
  let launched = 0;
  const disabled = fixture({
    launch: async () => {
      launched++;
      disabled.hub.attach(socket(), false, 3, { id: first, name: 'First' });
    },
  });
  await assert.rejects(disabled.connector.connect(first), /disabled/);
  assert.equal(launched, 1);
  assert.equal(disabled.hub.profiles.get(first).hub.browserEnabled, false);
});

test('concurrent callers share one launch; cancelling one does not cancel another', async () => {
  let release, reached;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const f = fixture({
    delay: async () => {
      reached();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const controller = new AbortController();
  const one = f.connector.connect(first, controller.signal);
  const two = f.connector.connect(first);
  await entered;
  assert.equal(f.connector.attempts.get(first).waiters.size, 2);
  const rejected = assert.rejects(one, /cancelled/);
  controller.abort();
  await rejected;
  release();
  assert.equal((await two).connected, true);
  assert.equal(f.launches(), 1);
});

test('cancellation and routing persistence failure prevent launch before dispatch', async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.connector.connect(first, abort.signal), /cancelled/);
  assert.equal(f.launches(), 0);
  f.hub.persistenceError = new Error('disk full');
  await assert.rejects(f.connector.connect(first), /persist/);
  assert.equal(f.launches(), 0);
});

test('cancelling every waiter releases the shared attempt without launching or retrying', async () => {
  let reached;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const f = fixture({
    delay: (_ms, _, { signal }) =>
      new Promise((resolve, reject) => {
        reached();
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      }),
  });
  const controller = new AbortController();
  const pending = f.connector.connect(first, controller.signal);
  const rejected = assert.rejects(pending, /cancelled|Aborted/);
  await entered;
  const attempt = f.connector.attempts.get(first).promise;
  const stopped = assert.rejects(attempt, /Aborted/);
  controller.abort();
  await Promise.all([rejected, stopped]);
  assert.equal(f.connector.attempts.size, 0);
  assert.equal(f.launches(), 0);
});

test('slow local validation cannot open Chrome after the connection budget expired', async () => {
  const f = fixture({
    resolve: async (mapping) => {
      f.setClock(1000);
      return mapping;
    },
  });
  await assert.rejects(f.connector.connect(first), /timed out before Chrome launch/);
  assert.equal(f.launches(), 0);
});

test('revoking launch approval during local validation prevents Chrome startup', async () => {
  let reads = 0;
  const f = fixture({
    load: async () => ({
      profiles:
        ++reads === 1 ? { [first]: { executable: 'approved', profilePath: 'approved' } } : {},
    }),
  });
  await assert.rejects(f.connector.connect(first), /approval changed/);
  assert.equal(f.launches(), 0);
});

test('enabled state survives disconnect and restart; authenticated disabling is persisted', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'chrome-enabled-state-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const url = pathToFileURL(path.join(root, 'profile-routing.json'));
  await writePrivateJSON(url, {
    version: 1,
    profiles: [{ id: first, name: 'First' }],
    selections: {},
  });
  const hub = await createProfileHub(url);
  assert.equal(hub.profilesSnapshot()[0].lastKnownEnabled, null);
  await assert.rejects(hub.connector.connect(first), /unknown/);
  const ws = socket();
  const browser = hub.attach(ws, true, 3, { id: first, name: 'First' });
  await hub.flush();
  ws.close();
  assert.equal((await readProfileState(url)).profiles[0].enabled, true);
  const restored = await createProfileHub(url);
  assert.equal(restored.profiles.get(first).enabled, true);
  const other = socket();
  const current = restored.attach(other, true, 3, { id: first, name: 'First' });
  current.receive({ type: 'availability', enabled: false });
  await restored.flush();
  other.close();
  assert.equal((await readProfileState(url)).profiles[0].enabled, false);
  assert.equal(browser.socket, null);
});

test('MCP/shared HTTP connect_profile launches once, preserves selection and leaves the healthy daemon unchanged', async (t) => {
  const hub = fixture().hub;
  const revision = 'a'.repeat(64);
  const bridge = createSharedBridge(
    { token, port: 0 },
    { hub, runtime: { installation: revision, revision, extensionRevision: revision } },
  );
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const config = { token, port: bridge.server.address().port };
  const base = `http://127.0.0.1:${config.port}`;
  const status = async () =>
    (await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const before = (await status()).bridgeID;
  let launches = 0,
    commands = 0,
    ws;
  hub.connector = new ProfileConnector(hub, {
    grace: 0,
    load: async () => ({ profiles: { [first]: {} } }),
    resolve: async (mapping) => mapping,
    launch: async () => {
      launches++;
      ws = new WebSocket(`ws://127.0.0.1:${config.port}/browser`, {
        origin: `chrome-extension://${'b'.repeat(32)}`,
      });
      ws.on('message', (data) => {
        if (JSON.parse(data).type === 'command') commands++;
      });
      await once(ws, 'open');
      const ready = once(ws, 'message');
      ws.send(
        JSON.stringify({
          type: 'hello',
          version: 3,
          token,
          enabled: true,
          bindings: {},
          profile: { id: first, name: 'First' },
        }),
      );
      await ready;
    },
  });
  t.after(() => ws?.terminate());
  const mcp = new McpServer({ name: 'connect-test', version: '1' });
  registerBrowserTools(
    mcp,
    new SharedBrowserHub(config, {
      readRevision: async () => {
        throw new Error('connect_profile must not activate updates');
      },
    }),
  );
  const client = new Client({ name: 'connect-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  const result = await client.callTool({
    name: 'connect_profile',
    arguments: { profileID: first },
    _meta: { 'ai.opencode/sessionID': 'ses_first' },
  });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.connected, true);
  assert.equal(payload.selectedProfileID, second);
  assert.equal(launches, 1);
  assert.equal(commands, 0);
  assert.equal((await status()).bridgeID, before);
});
