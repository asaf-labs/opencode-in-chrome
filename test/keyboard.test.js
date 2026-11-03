import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import { keyboardKey, keyboardText } from '../extension/keyboard-keys.js';
import { browserToolDefinitions } from '../bridge/tools.js';
import { z } from 'zod';

async function fixture(t) {
  const chrome = fakeChrome(),
    browser = new SessionBrowser(chrome);
  browser.enabled = true;
  const command = (tool, args = {}) => ({
    tool,
    args,
    id: crypto.randomUUID(),
    sessionID: 'ses_keys',
    generation: browser.bindings.ses_keys?.generation || 'g',
    expiresAt: Date.now() + 25_000,
  });
  const { tabID } = await browser.run(command('open_tab', { url: 'https://example.com' }));
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (request) => {
    if (request.func?.toString().includes("run('read_page'"))
      return [
        {
          frameId: 0,
          result: {
            documentID: `doc-${tabID}`,
            elements: [],
            focus: { token: crypto.randomUUID(), editable: true, tag: 'textarea' },
          },
        },
      ];
    return execute(request);
  };
  const snapshot = await browser.run(command('read_page'));
  t.after(() => browser.suspend());
  const input = (tool, args = {}) =>
    browser.run(command(tool, { focusToken: snapshot.focus.token, ...args }));
  return { chrome, browser, command, tabID, input };
}

test('keyboard schemas allow bounded editing/navigation and reject clipboard/browser shortcuts', () => {
  for (const key of [
    'Enter',
    'Shift+Tab',
    'Control+a',
    'Meta+a',
    'Control+Shift+z',
    'Control+Home',
    'Shift+ArrowDown',
    'F2',
    'Shift+1',
  ])
    assert.ok(keyboardKey(key));
  for (const key of [
    'Control+v',
    'Control+c',
    'Control+x',
    'Shift+Insert',
    'Shift+Delete',
    'Control+Shift+Delete',
    'Control+Shift+Backspace',
    'Control+Tab',
    'Control+PageDown',
    'Control+Shift+a',
    'Control+l',
    'Meta+w',
    'F12',
    'Alt+F4',
    'Control+Control+a',
    'Control+Meta+a',
    'constructor+a',
    '',
  ])
    assert.throws(() => keyboardKey(key), undefined, key);
  assert.equal(keyboardKey('Shift+1').key.key, '!');
  for (const text of ['', 'x'.repeat(10001), '\u0000', '\b'])
    assert.throws(() => keyboardText(text));
  assert.equal(keyboardText('שלום 🌍\nTab\there'), 'שלום 🌍\nTab\there');
  const schema = z
    .object(browserToolDefinitions.find(([name]) => name === 'press_key')[2])
    .strict();
  assert.equal(
    schema.safeParse({ key: 'Control+v', focusToken: `k0:${crypto.randomUUID()}` }).success,
    false,
  );
});

test('press_key sends trusted chord parameters and releases keys in reverse order without reading clipboard', async (t) => {
  const { chrome, tabID, input } = await fixture(t);
  const result = await input('press_key', { key: 'Control+a' });
  const events = chrome.debuggerCalls.filter((call) => call.method === 'Input.dispatchKeyEvent');
  assert.deepEqual(
    events.map((call) => [call.params.type, call.params.key, call.params.modifiers]),
    [
      ['keyDown', 'Control', 2],
      ['keyDown', 'a', 2],
      ['keyUp', 'a', 2],
      ['keyUp', 'Control', 0],
    ],
  );
  assert.ok(events.every((call) => call.target.tabId === tabID));
  assert.equal(result.dispatched, true);
  assert.equal(result.applicationAccepted, null);
  assert.equal(result.focusTokenConsumed, true);
});

test('insert_text sends literal Unicode directly to the owned tab and does not echo it in results', async (t) => {
  const { chrome, input } = await fixture(t);
  const text = 'שלום\nOverview\tDetails';
  const result = await input('insert_text', { text });
  assert.deepEqual(
    chrome.debuggerCalls
      .filter((call) => call.action === 'send')
      .map((call) => [call.method, call.params]),
    [['Input.insertText', { text }]],
  );
  assert.equal(JSON.stringify(result).includes(text), false);
});

test('personal tabs, unknown frames, background tabs and unfocused windows cannot receive keyboard input', async (t) => {
  for (const target of ['personal', 'frame', 'background', 'window']) {
    const { chrome, input } = await fixture(t);
    if (target === 'background') await chrome.tabs.update(1, { active: true });
    if (target === 'window') chrome.windows.get = async () => ({ focused: false });
    await assert.rejects(
      input('press_key', {
        key: 'Enter',
        ...(target === 'personal' ? { tabID: 1 } : {}),
        ...(target === 'frame' ? { focusToken: `k7:${crypto.randomUUID()}` } : {}),
      }),
    );
    assert.equal(chrome.debuggerCalls.length, 0);
  }
});

test('focus loss or cancellation after modifier-down prevents the main key and still releases modifiers', async (t) => {
  for (const change of ['focus', 'cancel']) {
    const { chrome, browser, command, tabID } = await fixture(t);
    const snapshot = await browser.run(command('read_page'));
    const pending = command('press_key', { key: 'Control+a', focusToken: snapshot.focus.token });
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (...args) => {
      const result = await send(...args);
      if (args[2]?.type === 'keyDown') {
        if (change === 'focus') await chrome.tabs.update(1, { active: true });
        else await browser.cancel(pending);
      }
      return result;
    };
    await assert.rejects(browser.run(pending), /may already have affected/);
    assert.deepEqual(
      chrome.debuggerCalls
        .filter((call) => call.method === 'Input.dispatchKeyEvent')
        .map((call) => [call.params.type, call.params.key]),
      [
        ['keyDown', 'Control'],
        ['keyUp', 'Control'],
      ],
    );
    assert.ok(chrome.debuggerCalls.every((call) => call.target.tabId === tabID));
    assert.equal(chrome.debuggerTabs.size, 0);
  }
});

test('key-up failures still release remaining modifiers and report an uncertain outcome', async (t) => {
  const { chrome, input } = await fixture(t);
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => {
    await send(...args);
    if (args[2]?.type === 'keyUp' && args[2]?.key === 'a') throw new Error('Key-up interrupted');
  };
  await assert.rejects(
    input('press_key', { key: 'Control+a' }),
    /Key-up interrupted.*may already have affected/,
  );
  assert.deepEqual(
    chrome.debuggerCalls
      .filter((call) => call.method === 'Input.dispatchKeyEvent')
      .map((call) => [call.params.type, call.params.key]),
    [
      ['keyDown', 'Control'],
      ['keyDown', 'a'],
      ['keyUp', 'a'],
      ['keyUp', 'Control'],
    ],
  );
  assert.equal(chrome.debuggerTabs.size, 0);
});

test('debugger loss after key-down is not reported as successful dispatch', async (t) => {
  const { chrome, browser, input, tabID } = await fixture(t);
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => {
    await send(...args);
    if (args[2]?.type === 'keyDown') await browser.debuggers.clear(tabID);
  };
  await assert.rejects(
    input('press_key', { key: 'Enter' }),
    /detached before key-up.*may already have affected/,
  );
  assert.equal(
    chrome.debuggerCalls.filter((call) => call.method === 'Input.dispatchKeyEvent').length,
    1,
  );
  assert.equal(chrome.debuggerTabs.size, 0);
});

test('navigation during attachment prevents input and protocol failures are never retried', async (t) => {
  const { chrome, browser, input, tabID } = await fixture(t);
  const attach = chrome.debugger.attach;
  chrome.debugger.attach = async (...args) => {
    await attach(...args);
    await browser.updated(
      tabID,
      { url: 'https://example.com/new' },
      { ...(await chrome.tabs.get(tabID)), url: 'https://example.com/new' },
    );
  };
  await assert.rejects(input('insert_text', { text: 'Never sent' }), /latest snapshot/);
  assert.equal(
    chrome.debuggerCalls.some((call) => call.method === 'Input.insertText'),
    false,
  );
  assert.equal(chrome.debuggerTabs.size, 0);
  const second = await fixture(t);
  const send = second.chrome.debugger.sendCommand;
  second.chrome.debugger.sendCommand = async (...args) => {
    await send(...args);
    if (args[1] === 'Input.insertText') throw new Error('Connection interrupted');
  };
  await assert.rejects(
    second.input('insert_text', { text: 'Maybe sent' }),
    /may already have affected/,
  );
  assert.equal(
    second.chrome.debuggerCalls.filter((call) => call.method === 'Input.insertText').length,
    1,
  );
});
