import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, cp, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createSharedBridge } from '../bridge/shared-server.js';
import { runtimeRevision, runtimeRoot } from '../bridge/runtime-revision.js';
import { ensureSharedDaemon, sharedStatus } from '../bridge/shared-process.js';
import { ensureConfig } from '../bridge/config.js';

const token = 'a'.repeat(64),
  origin = `chrome-extension://${'b'.repeat(32)}`;
const old = 'a'.repeat(64),
  next = 'b'.repeat(64);
const runtime = { installation: old, revision: old, extensionRevision: old };

async function fixture(t) {
  let disk = { ...runtime, revision: next, extensionRevision: next };
  const bridge = createSharedBridge(
    { token, port: 0 },
    { runtime, readRevision: async () => disk },
  );
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const status = await (
    await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const activate = (extra = {}) =>
    fetch(`${url}/activate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bridgeID: status.bridgeID,
        installation: old,
        revision: next,
        ...extra,
      }),
    });
  return {
    ...bridge,
    url,
    activate,
    setDisk: (value) => {
      disk = value;
    },
  };
}

async function profile(
  t,
  f,
  {
    support = true,
    prepare = async () => ({ prepared: true }),
    commit = async () => ({ committed: true }),
  } = {},
) {
  const ws = new WebSocket(f.url.replace('http:', 'ws:') + '/browser', { origin });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  const messages = [];
  ws.on('message', async (data) => {
    const message = JSON.parse(data);
    messages.push(message);
    if (message.type !== 'update') return;
    try {
      const result =
        message.method === 'prepare'
          ? await prepare(message)
          : message.method === 'commit'
            ? await commit(message)
            : { released: true };
      ws.send(JSON.stringify({ type: 'update_result', id: message.id, result }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'update_result', id: message.id, error: error.message }));
    }
  });
  const ready = once(ws, 'message');
  ws.send(
    JSON.stringify({
      type: 'hello',
      version: 3,
      profile: { id: crypto.randomUUID(), name: 'Disposable update fixture' },
      token,
      enabled: true,
      bindings: {},
      updateSupport: support ? 1 : undefined,
      extensionRevision: old,
    }),
  );
  await ready;
  return { ws, messages };
}

test('activation requires exact authenticated installation and daemon identity and never accepts browser origins', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.activate({ installation: next })).status, 409);
  assert.equal((await f.activate({ bridgeID: crypto.randomUUID() })).status, 409);
  assert.equal((await fetch(`${f.url}/activate`, { method: 'POST' })).status, 401);
  assert.equal(
    (
      await fetch(`${f.url}/activate`, {
        method: 'POST',
        headers: { Origin: origin, Authorization: `Bearer ${token}` },
      })
    ).status,
    403,
  );
});

test('busy, retained capture and older-profile update barriers defer without interrupting browser work', async (t) => {
  const f = await fixture(t);
  f.hub.inFlight.set('ses_active', 1);
  assert.equal((await (await f.activate()).json()).deferred, true);
  f.hub.inFlight.clear();
  const p = await profile(t, f, {
    prepare: async () => {
      throw new Error('Retained recording or inspection');
    },
  });
  const denied = await (await f.activate()).json();
  assert.equal(denied.activated, false);
  assert.match(denied.reason, /Retained/);
  assert.deepEqual(
    p.messages.filter((message) => message.type === 'update').map((message) => message.method),
    ['prepare', 'release'],
  );
  assert.equal(p.ws.readyState, WebSocket.OPEN);
  p.ws.close();
  await once(p.ws, 'close');
  const legacy = await profile(t, f, { support: false });
  assert.match((await (await f.activate()).json()).reason, /one-time/);
  assert.equal(legacy.ws.readyState, WebSocket.OPEN);
});

test('activation closes admission before async checks and concurrent activation cannot interrupt or replay calls', async (t) => {
  const f = await fixture(t);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let prepared;
  const reached = new Promise((resolve) => {
    prepared = resolve;
  });
  const p = await profile(t, f, {
    prepare: async () => {
      prepared();
      await blocked;
      return { prepared: true };
    },
  });
  const activation = f.activate();
  await reached;
  const call = await fetch(`${f.url}/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionID: 'ses_blocked', tool: 'open_tab', args: {} }),
  });
  assert.equal(call.status, 409);
  assert.match((await call.json()).error, /No action was dispatched/);
  assert.equal((await (await f.activate()).json()).deferred, true);
  assert.equal(
    p.messages.some((message) => message.type === 'command'),
    false,
  );
  release();
  assert.equal((await (await activation).json()).activated, true);
  await f.close();
});

test('all profile preparations settle before release, including a slow profile after another refuses', async (t) => {
  const f = await fixture(t);
  const p = await profile(t, f, {
    prepare: async () => {
      await setTimeout(30);
      return { prepared: true };
    },
  });
  await profile(t, f, {
    prepare: async () => {
      throw new Error('Busy');
    },
  });
  assert.equal((await (await f.activate()).json()).activated, false);
  assert.deepEqual(
    p.messages.filter((message) => message.type === 'update').map((message) => message.method),
    ['prepare', 'release'],
  );
});

test(
  'a changed runtime restarts an isolated idle daemon on next use without touching pairing or routing',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'chrome-auto-activation-'));
    for (const directory of ['bridge', 'extension', 'scripts'])
      await cp(path.join(runtimeRoot, directory), path.join(root, directory), { recursive: true });
    for (const filename of ['package.json', 'package-lock.json'])
      await cp(path.join(runtimeRoot, filename), path.join(root, filename));
    await symlink(
      path.join(runtimeRoot, 'node_modules'),
      path.join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const configURL = pathToFileURL(path.join(root, '.local/config.json'));
    const config = await ensureConfig({ port }, configURL);
    const options = {
      configURL,
      daemonURL: pathToFileURL(path.join(root, 'bridge/shared-daemon.js')),
      readRevision: () => runtimeRevision(root),
    };
    let client, socket, retry;
    let reconnecting = true;
    t.after(async () => {
      reconnecting = false;
      clearTimeout(retry);
      socket?.terminate();
      await client?.close();
      await fetch(`http://127.0.0.1:${port}/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}` },
      }).catch(() => {});
      for (let i = 0; i < 100 && (await sharedStatus(config)); i++) await setTimeout(20);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const initial = await ensureSharedDaemon(config, options);
    const profileID = crypto.randomUUID();
    const bindings = {
      ses_kept: {
        generation: 'owned-generation',
        tabs: [{ id: 7, keep: true, indicatorHidden: true }],
        currentTabID: 7,
      },
    };
    let loaded = initial.runtime.extensionRevision,
      capture = true;
    let ready;
    const firstReady = new Promise((resolve) => {
      ready = resolve;
    });
    const connect = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/browser`, { origin });
      socket = ws;
      ws.on('error', () => {});
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'hello',
            version: 3,
            profile: { id: profileID, name: 'Disabled disposable profile' },
            token: config.token,
            enabled: false,
            bindings,
            updateSupport: 1,
            extensionRevision: loaded,
          }),
        ),
      );
      ws.on('message', (data) => {
        const message = JSON.parse(data);
        if (message.type === 'ready') ready();
        if (message.type !== 'update') return;
        if (message.method === 'prepare' && capture) {
          ws.send(
            JSON.stringify({ type: 'update_result', id: message.id, error: 'Retained capture' }),
          );
          return;
        }
        if (message.method === 'commit') loaded = message.revision;
        ws.send(
          JSON.stringify({
            type: 'update_result',
            id: message.id,
            result: { prepared: true, committed: true, released: true },
          }),
        );
      });
      ws.on('close', () => {
        if (reconnecting) retry = globalThis.setTimeout(connect, 50);
      });
    };
    connect();
    await firstReady;
    const call = async (tool, args) =>
      (
        await fetch(`http://127.0.0.1:${port}/call`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionID: 'ses_kept', tool, args }),
        })
      ).json();
    await call('select_profile', { profileID });
    const before = await readFile(configURL, 'utf8');
    const filename = path.join(root, 'extension/content.js');
    await writeFile(filename, (await readFile(filename, 'utf8')) + '\n');
    const deferred = await ensureSharedDaemon(config, options);
    assert.equal(deferred.bridgeID, initial.bridgeID);
    assert.match(deferred.updateDeferred, /Retained capture/);
    capture = false;
    const [first, second] = await Promise.all([
      ensureSharedDaemon(config, options),
      ensureSharedDaemon(config, options),
    ]);
    const final = await ensureSharedDaemon(config, options);
    assert.notEqual(final.bridgeID, initial.bridgeID);
    assert.equal(final.runtime.revision, (await runtimeRevision(root)).revision);
    assert.equal(first.bridgeID === final.bridgeID || second.bridgeID === final.bridgeID, true);
    assert.equal(await readFile(configURL, 'utf8'), before);
    assert.equal(final.profiles[0].enabled, false);
    assert.deepEqual(final.bindings.ses_kept.tabs, bindings.ses_kept.tabs);
    assert.equal((await call('list_profiles', {})).result.selectedProfileID, profileID);
    client = new Client({ name: 'disposable-catalog-client', version: '1' });
    let notifications = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications++;
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(root, 'bridge/shared-main.js'),
          '--config',
          path.join(root, '.local/config.json'),
        ],
        stderr: 'pipe',
      }),
    );
    assert.equal((await client.listTools()).tools.length, 29);
    const tools = path.join(root, 'bridge/tools.js');
    await writeFile(
      tools,
      (await readFile(tools, 'utf8')).replace(
        'const definitions = [',
        "const definitions = [ ['update_probe', 'Disposable upgrade fixture', {}],",
      ),
    );
    assert.equal((await client.listTools()).tools.length, 30);
    assert.equal(notifications, 1);
    assert.equal(await readFile(configURL, 'utf8'), before);
  },
);
