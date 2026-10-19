import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import {
  redactBody,
  redactHeaders,
  redactText,
  redactURL,
} from '../extension/inspection-privacy.js';
import { saveInspectionArtifact } from '../bridge/inspection-artifacts.js';

async function fixture(t, captureBodies = false) {
  const chrome = fakeChrome(),
    browser = new SessionBrowser(chrome);
  browser.enabled = true;
  const command = (tool, args = {}, sessionID = 'ses_inspection') => ({
    tool,
    args,
    sessionID,
    id: crypto.randomUUID(),
    generation: browser.bindings[sessionID]?.generation || 'generation',
    expiresAt: Date.now() + 25000,
  });
  const tab = await browser.run(command('open_tab', { url: 'https://example.com/task' }));
  const tabID = tab.tabID;
  await browser.run(command('start_inspection', { tabID, captureBodies }));
  t.after(() => browser.suspend());
  const emit = (method, params, source = tabID) => chrome.emitDebugger(source, method, params);
  const request = (id = 'request', url = 'https://example.com/api?token=private') => {
    emit('Network.requestWillBeSent', {
      requestId: id,
      type: 'Fetch',
      timestamp: 1,
      wallTime: 1000,
      request: {
        url,
        method: 'POST',
        headers: {
          Authorization: 'Bearer private',
          'Content-Type': 'application/json',
          'X-Custom-Secret': 'private',
        },
        hasPostData: true,
        postData: '{"password":"private","value":42}',
      },
    });
    emit('Network.responseReceived', {
      requestId: id,
      response: {
        status: 500,
        mimeType: 'application/json',
        headers: { 'Set-Cookie': 'private', 'Content-Type': 'application/json' },
        timing: {
          dnsStart: 0,
          dnsEnd: 2,
          connectStart: 2,
          connectEnd: 4,
          sendEnd: 5,
          receiveHeadersEnd: 10,
        },
      },
    });
    emit('Network.loadingFinished', { requestId: id, timestamp: 1.5, encodedDataLength: 100 });
  };
  return { chrome, browser, command, tabID, emit, request };
}

test('redaction covers credentials, query secrets, unknown headers and nested JSON', () => {
  assert.equal(
    redactURL('https://user:pass@example.com/?token=private#secret').includes('private'),
    false,
  );
  assert.equal(redactURL('data:text/plain,private'), '[non-HTTP URL]');
  assert.equal(
    JSON.stringify(
      redactHeaders({
        Authorization: 'private',
        Cookie: 'private',
        'X-Unknown': 'private',
        'Content-Type': 'application/json',
      }),
    ).includes('private'),
    false,
  );
  assert.equal(redactText('Bearer private token=private').includes('private'), false);
  assert.equal(redactText('{"token":"private"} session=private').includes('private'), false);
  assert.equal(
    redactBody('{"user":{"password":"private"},"value":42}').text,
    '{"user":{"password":"[redacted]"},"value":42}',
  );
  assert.equal(redactBody('x'.repeat(129 * 1024)).reason, 'sizeLimit');
});

test('inspection has no personal tab, other session, child-target or expired-command access', async (t) => {
  const { chrome, browser, command, tabID, emit } = await fixture(t);
  await assert.rejects(browser.run(command('start_inspection', { tabID: 1 })), /session-owned/);
  for (const tool of [
    'network_requests',
    'console_logs',
    'stop_inspection',
    'start_cpu_profile',
    'start_performance_trace',
  ])
    await assert.rejects(browser.run(command(tool, { tabID }, 'ses_other')), /another session/);
  chrome.emitDebugger(
    tabID,
    'Runtime.consoleAPICalled',
    { type: 'log', args: [{ type: 'string', value: 'child-private' }] },
    'child',
  );
  emit(
    'Runtime.consoleAPICalled',
    { type: 'log', args: [{ type: 'string', value: 'personal-private' }] },
    1,
  );
  assert.deepEqual((await browser.run(command('console_logs', { tabID }))).messages, []);
  const expired = command('network_requests', { tabID });
  expired.expiresAt = 0;
  await assert.rejects(browser.run(expired), /expired/);
});

test('network inspection exposes metadata and redacted headers but does not read bodies by default', async (t) => {
  const { chrome, browser, command, tabID, request } = await fixture(t);
  request();
  const listed = await browser.run(command('network_requests', { tabID }));
  assert.equal(listed.requests.length, 1);
  assert.equal(listed.requests[0].statusCode, 500);
  assert.equal(listed.requests[0].state, 'completed');
  assert.equal(listed.requests[0].durationMs, 500);
  assert.equal(listed.requests[0].url.includes('private'), false);
  const row = await browser.run(
    command('network_request', { tabID, requestID: listed.requests[0].id, includeBody: true }),
  );
  assert.equal(row.responseBody.reason, 'captureBodiesDisabled');
  assert.equal(JSON.stringify(row).includes('private'), false);
  assert.equal(
    chrome.debuggerCalls.some((call) => call.method === 'Network.getResponseBody'),
    false,
  );
});

test('bodies require opt-in, are bounded and redacted, and binary bodies are not returned', async (t) => {
  const { chrome, browser, command, tabID, request } = await fixture(t, true);
  request();
  const listed = await browser.run(command('network_requests', { tabID }));
  const requestID = listed.requests[0].id;
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) =>
    args[1] === 'Network.getResponseBody'
      ? { body: '{"token":"private","answer":42}', base64Encoded: false }
      : send(...args);
  const row = await browser.run(
    command('network_request', { tabID, requestID, includeBody: true }),
  );
  assert.equal(JSON.stringify(row).includes('private'), false);
  assert.ok(row.responseBody.text.includes('42'));
  const small = await browser.run(
    command('network_request', { tabID, requestID, includeBody: true, maxBodyChars: 10 }),
  );
  assert.equal(small.requestBody.text.length, 10);
  assert.equal(small.requestBody.truncated, true);
  assert.equal(small.responseBody.text.length, 10);
  assert.equal(small.responseBody.truncated, true);
  chrome.debugger.sendCommand = async (...args) =>
    args[1] === 'Network.getResponseBody'
      ? { body: 'cHJpdmF0ZQ==', base64Encoded: true }
      : send(...args);
  const binary = await browser.run(
    command('network_request', { tabID, requestID, includeBody: true }),
  );
  assert.equal(binary.responseBody.reason, 'binary');
});

test('navigation invalidates request IDs even during asynchronous body retrieval', async (t) => {
  const { chrome, browser, command, tabID, request, emit } = await fixture(t, true);
  request();
  const { requests } = await browser.run(command('network_requests', { tabID }));
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => {
    if (args[1] === 'Network.getResponseBody') {
      emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/new' } });
      return { body: 'old-body', base64Encoded: false };
    }
    return send(...args);
  };
  await assert.rejects(
    browser.run(
      command('network_request', { tabID, requestID: requests[0].id, includeBody: true }),
    ),
    /expired/,
  );
  await assert.rejects(
    browser.run(command('network_request', { tabID, requestID: requests[0].id })),
    /expired/,
  );
  assert.equal((await browser.run(command('network_requests', { tabID }))).requests.length, 0);
});

test('console captures levels and exceptions without expanding objects; buffers are bounded', async (t) => {
  const { browser, command, tabID, emit } = await fixture(t);
  for (let index = 0; index < 305; index++)
    emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [
        { type: 'string', value: 'token=private' },
        { type: 'object', description: 'private-object' },
      ],
    });
  emit('Runtime.exceptionThrown', {
    exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: broken' } },
  });
  const result = await browser.run(command('console_logs', { tabID, level: 'error' }));
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].level, 'error');
  assert.equal(result.dropped, 6);
  const all = await browser.run(command('console_logs', { tabID, limit: 100 }));
  assert.equal(all.truncated, true);
  assert.equal(JSON.stringify(all).includes('private'), false);
});

test('request eviction and redirects cannot expose the wrong response body', async (t) => {
  const { browser, command, tabID, request, emit } = await fixture(t, true);
  for (let index = 0; index < 205; index++) request('r' + index);
  let result = await browser.run(command('network_requests', { tabID, limit: 100 }));
  assert.equal(result.dropped, 5);
  assert.equal(result.truncated, true);
  const original = result.requests.at(-1).id;
  emit('Network.requestWillBeSent', {
    requestId: 'r204',
    timestamp: 2,
    wallTime: 1001,
    type: 'Fetch',
    redirectResponse: { status: 302 },
    request: { url: 'https://example.com/redirect', method: 'GET' },
  });
  const row = await browser.run(
    command('network_request', { tabID, requestID: original, includeBody: true }),
  );
  assert.equal(row.responseBody.reason, 'notCaptured');
});

test('inspection shares debugger with clicks and recordings and stop does not detach active leases', async (t) => {
  const { browser, chrome, command, tabID } = await fixture(t);
  await browser.run(command('read_page', { tabID }));
  await browser.run(command('click', { tabID, ref: 'e1' }));
  assert.equal(chrome.debuggerCalls.filter((call) => call.action === 'attach').length, 1);
  assert.equal(chrome.debuggerTabs.has(tabID), true);
  const { recordingID } = await browser.run(
    command('start_recording', {
      tabID,
      task: 'Scroll',
      goal: 'Scrolled',
      steps: [
        {
          id: 'scroll',
          description: 'Scroll down',
          before: [{ url: 'https://example.com/task' }],
          actions: [{ tool: 'scroll', deltaY: 10 }],
          after: [{ url: 'https://example.com/task' }],
        },
      ],
      goalChecks: [{ url: 'https://example.com/task' }],
    }),
  );
  await browser.run(command('run_recording_step', { recordingID, stepID: 'scroll' }));
  assert.equal(chrome.debuggerCalls.filter((call) => call.action === 'attach').length, 1);
  assert.equal(chrome.debuggerTabs.has(tabID), true);
  await browser.run(command('stop_inspection', { tabID }));
  assert.equal(chrome.debuggerTabs.size, 0);
});

test('profiles are bounded, explicit, sanitized and navigation invalidates them', async (t) => {
  const { browser, command, tabID } = await fixture(t);
  await assert.rejects(
    browser.run(command('start_cpu_profile', { tabID, durationMs: 60000 })),
    /30 seconds/,
  );
  await browser.run(command('start_cpu_profile', { tabID, durationMs: 1000 }));
  const cpu = await browser.run(command('stop_cpu_profile', { tabID }));
  assert.equal(cpu.kind, 'cpu-profile');
  assert.equal(JSON.stringify(cpu).includes('private'), false);
  await browser.run(command('start_performance_trace', { tabID, durationMs: 1000 }));
  const performance = await browser.run(command('stop_performance_trace', { tabID }));
  assert.equal(performance.kind, 'performance-timeline');
  assert.equal(performance.data.traceEvents[0].name, 'ready');
  assert.equal(performance.data.metadata.source, 'main-frame-performance-observer');
  await browser.inspections.navigated(tabID);
  await assert.rejects(browser.run(command('stop_cpu_profile', { tabID })), /No profile/);
});

test('stop, disable, detach, and protected-page navigation discard inspection and release debugger', async (t) => {
  for (const action of ['stop', 'disable', 'detach', 'protected']) {
    const { browser, chrome, command, tabID } = await fixture(t);
    if (action === 'stop') await browser.run(command('stop_inspection', { tabID }));
    if (action === 'disable') await browser.suspend();
    if (action === 'detach') {
      chrome.detachDebugger(tabID);
      await browser.inspections.remove(tabID);
    }
    if (action === 'protected')
      await browser.updated(
        tabID,
        { url: 'chrome://settings' },
        { ...(await chrome.tabs.get(tabID)), url: 'chrome://settings' },
      );
    assert.equal(browser.inspections.states.size, 0);
    assert.equal(chrome.debuggerTabs.size, 0);
  }
});

test('inspection artifact exports are private and return paths, not samples', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'inspection-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await saveInspectionArtifact(
    {
      kind: 'cpu-profile',
      data: { nodes: [], samples: [] },
      summary: { samples: 0, artifactPath: '/not-the-path' },
    },
    { root },
  );
  assert.ok(result.artifactPath.startsWith(root));
  assert.equal(result.data, undefined);
  assert.equal(JSON.parse(await readFile(result.artifactPath, 'utf8')).samples.length, 0);
  if (process.platform !== 'win32')
    assert.equal((await stat(result.artifactPath)).mode & 0o777, 0o600);
});

test('stopping before tab lookup returns cannot leave a debugger attachment behind', async (t) => {
  const { browser, chrome, command, tabID } = await fixture(t);
  await browser.run(command('stop_inspection', { tabID }));
  const started = Promise.withResolvers(),
    release = Promise.withResolvers(),
    get = chrome.tabs.get;
  chrome.tabs.get = async (id) => {
    started.resolve();
    await release.promise;
    return get(id);
  };
  const pending = browser.run(command('start_inspection', { tabID }));
  const rejected = assert.rejects(pending, /stopped/);
  await started.promise;
  await browser.run(command('stop_inspection', { tabID }));
  release.resolve();
  await rejected;
  assert.equal(chrome.debuggerTabs.size, 0);
});

test('disabling during pending inspection attachment waits for detach and retains no capture', async (t) => {
  const { browser, chrome, command, tabID } = await fixture(t);
  await browser.run(command('stop_inspection', { tabID }));
  const started = Promise.withResolvers(),
    release = Promise.withResolvers(),
    attach = chrome.debugger.attach;
  chrome.debugger.attach = async (...args) => {
    started.resolve();
    await release.promise;
    return attach(...args);
  };
  const pending = browser.run(command('start_inspection', { tabID }));
  const rejected = assert.rejects(pending, /Enable browser/);
  await started.promise;
  const stopped = browser.suspend();
  release.resolve();
  await stopped;
  await rejected;
  assert.equal(chrome.debuggerTabs.size, 0);
  assert.equal(browser.inspections.states.size, 0);
});

test('main document request survives navigation while old requests and profiles are discarded', async (t) => {
  const { browser, command, tabID, emit, request } = await fixture(t);
  request('old');
  emit('Network.requestWillBeSent', {
    requestId: 'document',
    loaderId: 'new-loader',
    timestamp: 2,
    wallTime: 1001,
    type: 'Document',
    request: { url: 'https://example.com/new', method: 'GET' },
  });
  emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'new-loader' } });
  const { requests } = await browser.run(command('network_requests', { tabID }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.com/new');
  emit('Page.navigatedWithinDocument', { frameId: 'main' });
  assert.equal((await browser.run(command('network_requests', { tabID }))).requests.length, 0);
});

test('profiles stop automatically and exported profiles can be replaced without another attachment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { browser, chrome, command, tabID } = await fixture(t);
  await browser.run(command('start_cpu_profile', { tabID, durationMs: 1000 }));
  t.mock.timers.tick(1000);
  const state = browser.inspections.states.get(tabID);
  await state.cpu.completion;
  assert.equal(
    chrome.debuggerCalls.some((call) => call.method === 'Profiler.stop'),
    true,
  );
  await browser.run(command('stop_cpu_profile', { tabID }));
  await browser.run(command('start_cpu_profile', { tabID, durationMs: 1000 }));
  await browser.run(command('stop_cpu_profile', { tabID }));
  assert.equal(chrome.debuggerCalls.filter((call) => call.action === 'attach').length, 1);
});
