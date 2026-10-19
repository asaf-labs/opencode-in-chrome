import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { ProfileHub, createProfileHub } from '../bridge/profiles.js';
import { createBridgeHttp } from '../bridge/http.js';
import { createSharedBridge } from '../bridge/shared-server.js';
import { SharedBrowserHub } from '../bridge/shared-client.js';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerBrowserTools } from '../bridge/tools.js';
import { saveInspectionArtifact } from '../bridge/inspection-artifacts.js';
import { saveRecordingArtifacts } from '../bridge/recording-artifacts.js';

const work = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Work' };
const personal = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Personal' };
const token = 'c'.repeat(64);
const origin = `chrome-extension://${'d'.repeat(32)}`;

async function fixture(t, { hub = new ProfileHub(), shared = false } = {}) {
  const bridge = shared
    ? createSharedBridge({ token, port: 0 }, { hub })
    : createBridgeHttp({ token, port: 0, hub });
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  t.after(async () => {
    for (const socket of bridge.sockets.clients) socket.terminate();
    bridge.server.closeAllConnections();
    if (bridge.close) await bridge.close();
    else await new Promise((resolve) => bridge.server.close(resolve));
    await hub.writing;
  });
  const port = bridge.server.address().port;
  const connect = async (profile, { candidate = token, enabled = true, automatic = true } = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/browser`, { origin });
    await once(socket, 'open');
    const response = once(socket, 'message');
    const closed = once(socket, 'close');
    socket.send(
      JSON.stringify({
        type: 'hello',
        version: 3,
        token: candidate,
        profile,
        enabled,
        bindings: {},
      }),
    );
    const first = await Promise.race([
      response.then(([data]) => ({ ready: JSON.parse(data) })),
      closed.then(([code]) => ({ code })),
    ]);
    if (!first.ready) return { socket, ...first };
    assert.equal(first.ready.profileID, profile.id);
    const chrome = fakeChrome();
    const browser = new SessionBrowser(chrome, (message) => socket.send(JSON.stringify(message)));
    browser.enabled = enabled;
    if (automatic)
      socket.on('message', async (data) => {
        const message = JSON.parse(data);
        if (message.type === 'cancel') return browser.cancel(message);
        if (message.type !== 'command') return;
        try {
          let result = await browser.run(message);
          if (message.tool === 'read_page')
            result = { ...result, elements: [{ ref: 'e1', label: profile.name }] };
          socket.send(JSON.stringify({ type: 'result', id: message.id, result }));
        } catch (error) {
          socket.send(JSON.stringify({ type: 'result', id: message.id, error: error.message }));
        }
      });
    return { socket, chrome, browser, ...first };
  };
  return { hub, connect, config: { token, port }, url: `http://127.0.0.1:${port}` };
}

test('two opted-in profiles stay connected; conversations select explicitly and duplicate tab IDs remain isolated', async (t) => {
  const { hub, connect } = await fixture(t);
  const a = await connect(work),
    b = await connect(personal);
  assert.equal(hub.profilesSnapshot().filter((profile) => profile.connected).length, 2);
  await assert.rejects(hub.call('ses_a', 'open_tab', {}), /Multiple browser profiles/);
  const selected = await hub.call('ses_a', 'select_profile', { profileID: work.id });
  assert.equal(selected.name, 'Work');
  await hub.call('ses_b', 'select_profile', { profileID: personal.id });
  const first = await hub.call('ses_a', 'open_tab', { url: 'https://example.com' });
  const second = await hub.call('ses_b', 'open_tab', { url: 'https://example.com' });
  assert.equal(first.tabID, second.tabID);
  assert.equal(first.profileID, work.id);
  assert.equal(second.profileID, personal.id);
  const snapshot = await hub.call('ses_a', 'read_page', {});
  assert.equal(snapshot.elements[0].ref, `p${work.id}:e1`);
  await assert.rejects(
    hub.call('ses_a', 'close_tab', { tabID: second.tabID }),
    /profileID alongside/,
  );
  await assert.rejects(
    hub.call('ses_a', 'close_tab', { profileID: personal.id, tabID: second.tabID }),
    /select_profile explicitly/,
  );
  await hub.call('ses_a', 'select_profile', { profileID: personal.id });
  await assert.rejects(
    hub.call('ses_a', 'close_tab', { profileID: personal.id, tabID: second.tabID }),
    /does not own/,
  );
  await hub.call('ses_a', 'select_profile', { profileID: work.id });
  await hub.call('ses_a', 'close_tab', { profileID: work.id, tabID: first.tabID });
  assert.equal(a.chrome.tabState.has(first.tabID), false);
  assert.equal(b.chrome.tabState.has(second.tabID), true);
});

test('even a lone named profile needs an explicit first choice rather than migrating an old conversation implicitly', async (t) => {
  const { hub, connect } = await fixture(t);
  const browser = await connect(work);
  await assert.rejects(
    hub.call('ses_older_conversation', 'open_tab', {}),
    /Select a browser profile/,
  );
  assert.equal(browser.chrome.tabState.size, 1);
  assert.equal(
    (await hub.call('ses_older_conversation', 'open_tab', { profileID: work.id })).profileID,
    work.id,
  );
});

test("a profile cannot resolve another profile's pending result or replace it using a duplicate identity", async (t) => {
  const { hub, connect } = await fixture(t);
  const a = await connect(work, { automatic: false });
  const b = await connect(personal, { automatic: false });
  await hub.call('ses_a', 'select_profile', { profileID: work.id });
  const sent = once(a.socket, 'message');
  const pending = hub.call('ses_a', 'list_tabs', {});
  const [bytes] = await sent;
  const command = JSON.parse(bytes);
  const foreignProcessed = once(hub.profiles.get(personal.id).hub.socket, 'message');
  b.socket.send(JSON.stringify({ type: 'result', id: command.id, result: { stolen: true } }));
  await foreignProcessed;
  assert.equal(hub.profiles.get(work.id).hub.pending.has(command.id), true);
  const duplicate = await connect(work);
  assert.equal(duplicate.code, 4009);
  assert.equal(a.socket.readyState, WebSocket.OPEN);
  a.socket.send(JSON.stringify({ type: 'result', id: command.id, result: { tabs: [] } }));
  assert.equal((await pending).stolen, undefined);
});

test('disable and disconnect affect only the selected profile and never fall back', async (t) => {
  const { hub, connect } = await fixture(t);
  const a = await connect(work),
    b = await connect(personal);
  await hub.call('ses_a', 'select_profile', { profileID: work.id });
  await hub.call('ses_b', 'select_profile', { profileID: personal.id });
  const unavailable = once(hub.profiles.get(work.id).hub.socket, 'message');
  a.socket.send(JSON.stringify({ type: 'availability', enabled: false }));
  await unavailable;
  await assert.rejects(hub.call('ses_a', 'open_tab', {}), /disabled/);
  assert.equal((await hub.call('ses_b', 'open_tab', {})).profileID, personal.id);
  const closed = once(hub.profiles.get(work.id).hub.socket, 'close');
  a.socket.close();
  await closed;
  await assert.rejects(hub.call('ses_a', 'open_tab', {}), /no fallback/);
  assert.equal(b.socket.readyState, WebSocket.OPEN);
});

test('switching profile rejects old scoped refs, and cannot happen while an action is pending', async (t) => {
  const { hub, connect } = await fixture(t);
  const a = await connect(work),
    b = await connect(personal);
  await hub.call('ses_a', 'open_tab', { profileID: work.id, url: 'https://example.com' });
  const snapshot = await hub.call('ses_a', 'read_page', {});
  await hub.call('ses_a', 'select_profile', { profileID: personal.id });
  await hub.call('ses_a', 'open_tab', {});
  await assert.rejects(
    hub.call('ses_a', 'click', { ref: snapshot.elements[0].ref }),
    /different profile/,
  );
  assert.equal(b.chrome.debuggerCalls.length, 0);
  a.socket.removeAllListeners('message');
  await hub.call('ses_a', 'select_profile', { profileID: work.id });
  const controller = new AbortController();
  const sent = once(a.socket, 'message');
  const pending = hub.call('ses_a', 'list_tabs', {}, controller.signal);
  const rejected = assert.rejects(pending, /cancelled/);
  await sent;
  await assert.rejects(
    hub.call('ses_a', 'select_profile', { profileID: personal.id }),
    /before switching/,
  );
  controller.abort();
  await rejected;
});

test('authenticated and validated profile handshakes precede registration; opt-out does not enable access', async (t) => {
  const { hub, connect } = await fixture(t);
  await connect(work);
  assert.equal((await connect(personal, { candidate: 'wrong' })).code, 4003);
  assert.equal((await connect({ ...personal, name: '' })).code, 4002);
  assert.equal(hub.profiles.size, 1);
  await connect(personal, { enabled: false });
  await hub.call('ses_b', 'select_profile', { profileID: personal.id });
  await assert.rejects(hub.call('ses_b', 'open_tab', {}), /disabled/);
  assert.equal(
    hub.profilesSnapshot().find((profile) => profile.profileID === work.id).enabled,
    true,
  );
});

test('per-conversation profile choice survives daemon restart even when only another profile reconnects', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chrome-profile-routing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = pathToFileURL(path.join(directory, 'profile-routing.json'));
  const first = await createProfileHub(url);
  const f = await fixture(t, { hub: first });
  await f.connect(work);
  await f.connect(personal);
  await first.call('ses_remembered', 'select_profile', { profileID: work.id });
  await first.flush();
  const second = await createProfileHub(url);
  const g = await fixture(t, { hub: second });
  await g.connect(personal);
  await assert.rejects(second.call('ses_remembered', 'open_tab', {}), /no fallback/);
  await assert.rejects(second.call('ses_fresh', 'open_tab', {}), /Multiple browser profiles/);
  assert.equal((await second.call('ses_remembered', 'list_profiles')).selectedProfileID, work.id);
  const saved = await readFile(url, 'utf8');
  assert.equal(saved.includes(token), false);
  if (process.platform !== 'win32') assert.equal((await stat(url)).mode & 0o777, 0o600);
  await writeFile(url, '{ broken');
  await assert.rejects(createProfileHub(url), /routing was not reset/);
});

test('profile selection and scoped refs also traverse the authenticated shared HTTP adapter', async (t) => {
  const f = await fixture(t, { shared: true });
  await f.connect(work);
  await f.connect(personal);
  const client = new SharedBrowserHub(f.config);
  const server = new McpServer({ name: 'profile-test', version: '1.0.0' });
  registerBrowserTools(server, client);
  const sdk = new Client({ name: 'opencode-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await sdk.connect(clientTransport);
  t.after(() => sdk.close());
  assert.equal((await sdk.listTools()).tools.length, 27);
  const call = async (name, args) => {
    const result = await sdk.callTool({
      name,
      arguments: args,
      _meta: { 'ai.opencode/sessionID': 'ses_http' },
    });
    assert.notEqual(result.isError, true, result.content[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const profiles = await call('list_profiles', {});
  assert.equal(profiles.profiles.length, 2);
  await call('select_profile', { profileID: work.id });
  await call('open_tab', { url: 'https://example.com' });
  const snapshot = await call('read_page', {});
  await call('type', { ref: snapshot.elements[0].ref, text: 'Coupa' });
  assert.equal(snapshot.profileID, work.id);
});

test('profile routing persistence errors fail closed before any browser command', async (t) => {
  let writable = false;
  const hub = new ProfileHub({
    save: async () => {
      if (!writable) throw new Error('simulated permission denial');
    },
  });
  const f = await fixture(t, { hub });
  const browser = await f.connect(work);
  await assert.rejects(
    hub.call('ses_no_disk', 'open_tab', { profileID: work.id, url: 'https://example.com' }),
    /No browser action was sent/,
  );
  assert.equal(browser.chrome.tabState.size, 1);
  assert.equal(hub.pending.size, 0);
  writable = true;
  assert.equal(
    (await hub.call('ses_no_disk', 'open_tab', { profileID: work.id, url: 'https://example.com' }))
      .profileID,
    work.id,
  );
});

test('profile-routed inspection and recording exports persist through MCP and shared HTTP without raw payloads', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-capture-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(t, { shared: true });
  const a = await f.connect(work);
  const b = await f.connect(personal);
  t.after(() => Promise.all([a.browser.suspend(), b.browser.suspend()]));
  const server = new McpServer({ name: 'profile-captures', version: 'test' });
  registerBrowserTools(server, new SharedBrowserHub(f.config), {
    saveInspection: (output) =>
      saveInspectionArtifact(output, { root: path.join(root, 'inspections') }),
    saveRecording: (output) =>
      saveRecordingArtifacts(output, { root: path.join(root, 'recordings') }),
  });
  const sdk = new Client({ name: 'profile-captures', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await sdk.connect(clientTransport);
  t.after(() => sdk.close());
  const call = async (name, args) => {
    const output = await sdk.callTool({
      name,
      arguments: { ...args, profileID: work.id },
      _meta: { 'ai.opencode/sessionID': 'ses_captures' },
    });
    assert.notEqual(output.isError, true, output.content[0]?.text);
    return JSON.parse(output.content[0].text);
  };
  await call('select_profile', {});
  const tab = await call('open_tab', { url: 'https://example.com' });
  await call('start_inspection', { tabID: tab.tabID });
  assert.equal(b.chrome.debuggerTabs.size, 0);
  await call('start_cpu_profile', { tabID: tab.tabID, durationMs: 1000 });
  const cpu = await call('stop_cpu_profile', { tabID: tab.tabID });
  assert.equal(cpu.profileID, work.id);
  assert.equal(cpu.data, undefined);
  assert.ok(JSON.parse(await readFile(cpu.artifactPath, 'utf8')).samples.length);
  await call('start_performance_trace', { tabID: tab.tabID, durationMs: 1000 });
  const timeline = await call('stop_performance_trace', { tabID: tab.tabID });
  assert.equal(timeline.profileID, work.id);
  assert.equal(timeline.data, undefined);
  assert.ok(JSON.parse(await readFile(timeline.artifactPath, 'utf8')).traceEvents.length);
  const { recordingID } = await call('start_recording', {
    tabID: tab.tabID,
    task: 'Scroll',
    goal: 'Scrolled',
    steps: [
      {
        id: 'scroll',
        description: 'Scroll',
        before: [{ url: 'https://example.com/' }],
        actions: [{ tool: 'scroll', deltaY: 10 }],
        after: [{ url: 'https://example.com/' }],
      },
    ],
    goalChecks: [{ url: 'https://example.com/' }],
  });
  await call('run_recording_step', { recordingID, stepID: 'scroll' });
  const recording = await call('finish_recording', { recordingID });
  assert.equal(recording.profileID, work.id);
  assert.equal(recording.video, undefined);
  assert.equal((await readFile(recording.videoPath)).subarray(0, 4).toString('hex'), '1a45dfa3');
  assert.equal(a.browser.recordings.sessions.size, 0);
  await call('stop_inspection', { tabID: tab.tabID });
  assert.equal(a.chrome.debuggerTabs.size, 0);
});

test('an old unnamed extension cannot replace an already connected legacy profile', async (t) => {
  const f = await fixture(t);
  const first = new WebSocket(f.url.replace('http:', 'ws:') + '/browser', { origin });
  await once(first, 'open');
  const ready = once(first, 'message');
  first.send(JSON.stringify({ type: 'hello', version: 2, token, enabled: true, bindings: {} }));
  await ready;
  const second = new WebSocket(f.url.replace('http:', 'ws:') + '/browser', { origin });
  await once(second, 'open');
  const closed = once(second, 'close');
  second.send(JSON.stringify({ type: 'hello', version: 2, token, enabled: true, bindings: {} }));
  assert.equal((await closed)[0], 4009);
  assert.equal(first.readyState, WebSocket.OPEN);
});
