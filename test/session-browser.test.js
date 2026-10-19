import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';

function fixture() {
  const chrome = fakeChrome(),
    messages = [];
  const browser = new SessionBrowser(chrome, (message) => messages.push(structuredClone(message)));
  browser.enabled = true;
  const command = (
    tool,
    args = {},
    sessionID = 'ses_one',
    generation = browser.bindings[sessionID]?.generation || `generation-${sessionID}`,
  ) => ({ tool, args, sessionID, generation, expiresAt: Date.now() + 25000 });
  return { browser, chrome, command, messages };
}

test('multiple owned tabs can be focused, navigated, closed without touching personal tabs', async () => {
  const { browser, chrome, command } = fixture();
  const first = await browser.run(command('open_tab'));
  await browser.run(command('navigate', { tabID: first.tabID, url: 'https://example.com' }));
  const second = await browser.run(command('open_tab', { url: 'https://example.org' }));
  await browser.run(command('focus_tab', { tabID: first.tabID }));
  assert.equal((await browser.run(command('list_tabs'))).currentTabID, first.tabID);
  await browser.run(command('close_tab', { tabID: first.tabID }));
  assert.equal((await browser.run(command('list_tabs'))).currentTabID, second.tabID);
  assert.equal(chrome.tabState.get(1).url, 'https://personal.example');
});

test('no tool can target a personal tab or a different session’s tab', async () => {
  const { browser, chrome, command } = fixture();
  const other = await browser.run(command('open_tab', { url: 'https://example.com' }, 'ses_other'));
  const scriptCount = chrome.scriptCalls.length;
  for (const tool of [
    'read_page',
    'click',
    'type',
    'select',
    'check',
    'scroll',
    'navigate',
    'screenshot',
    'focus_tab',
    'close_tab',
  ]) {
    for (const tabID of [1, other.tabID])
      await assert.rejects(browser.run(command(tool, { tabID })), /does not own/);
  }
  assert.equal(chrome.scriptCalls.length, scriptCount);
  assert.equal(chrome.debuggerCalls.length, 0);
  assert.ok(chrome.tabState.has(1));
});

test('document refs stay per-tab and are cleared on navigation', async () => {
  const { browser, chrome, command } = fixture();
  const a = await browser.run(command('open_tab', { url: 'https://example.com' }));
  const b = await browser.run(command('open_tab', { url: 'https://example.org' }));
  await browser.run(command('read_page', { tabID: a.tabID }));
  await browser.run(command('read_page', { tabID: b.tabID }));
  await browser.run(command('click', { tabID: a.tabID, ref: 'e1' }));
  assert.equal(chrome.scriptCalls.at(-1).args[0].documentID, `doc-${a.tabID}`);
  await browser.run(command('navigate', { tabID: a.tabID, url: 'https://example.com/new' }));
  assert.equal(browser.documents.get(a.tabID), undefined);
  assert.equal(browser.documents.get(b.tabID), `doc-${b.tabID}`);
});

test('ownership survives worker restart; missing tabs and v1 manual bindings are excluded', async () => {
  const { browser, chrome, command } = fixture();
  const owned = await browser.run(command('open_tab', { url: 'https://example.com' }));
  const saved = structuredClone(browser.bindings);
  saved.ses_one.tabs.push({ id: 999 });
  saved.ses_old = { tabID: 1, generation: 'old-manual-binding' };
  const restarted = new SessionBrowser(chrome);
  await restarted.restore(saved);
  assert.deepEqual(
    restarted.bindings.ses_one.tabs.map((tab) => tab.id),
    [owned.tabID],
  );
  assert.equal(restarted.bindings.ses_old, undefined);
});

test('new tabs spawned from an owned tab inherit ownership, personal-tab children do not', async () => {
  const { browser, command } = fixture();
  const owned = await browser.run(command('open_tab', { url: 'https://example.com' }));
  await browser.created({ id: 200, openerTabId: owned.tabID, url: 'https://child.example' });
  await browser.created({ id: 201, openerTabId: 1, url: 'https://personal-child.example' });
  assert.deepEqual(
    browser.bindings.ses_one.tabs.map((tab) => tab.id),
    [owned.tabID, 200],
  );
});

test('expired and disabled commands cannot create tabs; re-enable cannot revive queued commands', async () => {
  const { browser, chrome, command } = fixture();
  const expired = { ...command('open_tab'), expiresAt: Date.now() - 1 };
  await assert.rejects(browser.run(expired), /expired/);
  await browser.run(command('list_tabs'));
  const queued = command('open_tab');
  browser.enabled = false;
  await browser.invalidate();
  await assert.rejects(browser.run(queued), /Enable browser/);
  browser.enabled = true;
  await assert.rejects(browser.run(queued), /stopped or changed/);
  assert.equal(chrome.tabState.size, 1);
});

test('owned tabs get orange groups per session; personal tabs remain unmarked', async () => {
  const { browser, chrome, command } = fixture();
  const a = await browser.run(command('open_tab', { url: 'https://example.com' }));
  const b = await browser.run(command('open_tab', { url: 'https://example.org' }));
  const c = await browser.run(command('open_tab', { url: 'https://another.example' }, 'ses_two'));
  const firstGroup = chrome.tabState.get(a.tabID).groupId;
  assert.equal(chrome.tabState.get(b.tabID).groupId, firstGroup);
  assert.notEqual(chrome.tabState.get(c.tabID).groupId, firstGroup);
  assert.equal(chrome.groupState.get(firstGroup).color, 'orange');
  assert.match(chrome.groupState.get(firstGroup).title, /OpenCode/);
  assert.equal(chrome.tabState.get(1).groupId, undefined);
  browser.enabled = false;
  await browser.refreshIndicators();
  assert.equal(chrome.groupState.get(firstGroup).color, 'grey');
  assert.equal(chrome.scriptCalls.at(-1).args[0], false);
});

test('navigation completion installs the control overlay only on owned tabs', async () => {
  const { browser, chrome, command } = fixture();
  const owned = await browser.run(command('open_tab', { url: 'https://example.com' }));
  chrome.scriptCalls.length = 0;
  await browser.updated(1, { status: 'complete' }, await chrome.tabs.get(1));
  assert.equal(chrome.scriptCalls.length, 0);
  await browser.updated(owned.tabID, { status: 'complete' }, await chrome.tabs.get(owned.tabID));
  assert.equal(chrome.scriptCalls[0].files[0], 'content.js');
  assert.equal(chrome.scriptCalls[1].args[0], true);
});

test('page-dot visibility is per owned tab and survives worker restoration', async () => {
  const { browser, chrome, command } = fixture();
  const a = await browser.run(command('open_tab', { url: 'https://example.com' }));
  const b = await browser.run(command('open_tab', { url: 'https://example.org' }));
  await browser.setIndicatorHidden(a.tabID, true);
  assert.equal(
    browser.bindings.ses_one.tabs.find((tab) => tab.id === a.tabID).indicatorHidden,
    true,
  );
  assert.notEqual(
    browser.bindings.ses_one.tabs.find((tab) => tab.id === b.tabID).indicatorHidden,
    true,
  );
  assert.equal(chrome.scriptCalls.at(-1).args[1], true);
  await assert.rejects(browser.setIndicatorHidden(1, true), /not agent-owned/);
  const restarted = new SessionBrowser(chrome);
  await restarted.restore(chrome.saved.ownedSessionsV2);
  assert.equal(
    restarted.bindings.ses_one.tabs.find((tab) => tab.id === a.tabID).indicatorHidden,
    true,
  );
  assert.equal(browser.enabled, true);
});

test('connection loss suspends actions and notifies only owned pages', async () => {
  const { browser, chrome, command } = fixture();
  const owned = await browser.run(command('open_tab', { url: 'https://example.com' }));
  const queued = command('click', { ref: 'e1' });
  await browser.suspend();
  assert.equal(browser.enabled, false);
  assert.deepEqual(
    chrome.messages.map((m) => m.tabID),
    [owned.tabID],
  );
  assert.equal(chrome.messages[0].message.type, 'opencode-disable');
  browser.enabled = true;
  await assert.rejects(browser.run(queued), /stopped or changed/);
});

test('cancelled commands cannot run and cancellation messages target their owned tab', async () => {
  const { browser, chrome, command } = fixture();
  const owned = await browser.run(command('open_tab', { url: 'https://example.com' }));
  const pending = {
    ...command('click', { ref: 'e1' }),
    id: 'action-one',
    executingTabID: owned.tabID,
  };
  await browser.cancel(pending);
  await assert.rejects(browser.run(pending), /cancelled/);
  assert.deepEqual(chrome.messages[0], {
    tabID: owned.tabID,
    message: { type: 'opencode-cancel', id: 'action-one' },
  });
});

test('click dispatch uses the owned tab and complete browser mouse input with explicit outcome semantics', async () => {
  const { browser, chrome, command } = fixture();
  const tab = await browser.run(command('open_tab', { url: 'https://example.com' }));
  await browser.run(command('read_page'));
  const result = await browser.run(command('click', { ref: 'e1' }));
  assert.deepEqual(result, { tabID: tab.tabID, dispatched: true, applicationAccepted: null });
  assert.deepEqual(
    chrome.debuggerCalls.map((call) => call.action),
    ['attach', 'send', 'send', 'send'],
  );
  assert.equal(chrome.debuggerCalls[0].version, '1.3');
  assert.ok(chrome.debuggerCalls.every((call) => call.target.tabId === tab.tabID));
  assert.deepEqual(
    chrome.debuggerCalls
      .filter((call) => call.action === 'send')
      .map((call) => ({ method: call.method, ...call.params })),
    [
      { method: 'Input.dispatchMouseEvent', type: 'mouseMoved', x: 50, y: 10, buttons: 0 },
      {
        method: 'Input.dispatchMouseEvent',
        type: 'mousePressed',
        x: 50,
        y: 10,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      },
      {
        method: 'Input.dispatchMouseEvent',
        type: 'mouseReleased',
        x: 50,
        y: 10,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      },
    ],
  );
  assert.equal(
    chrome.scriptCalls.filter((call) => call.args?.[0]?.snapshotRevision !== undefined).length,
    2,
  );
  assert.equal(chrome.debuggerTabs.size, 1);
  await browser.debuggers.clear();
  assert.equal(chrome.debuggerTabs.size, 0);
});

test('debugger attachment failures do not detach another debugger or fall back to synthetic clicks', async () => {
  const { browser, chrome, command } = fixture();
  const tab = await browser.run(command('open_tab', { url: 'https://example.com' }));
  await browser.run(command('read_page'));
  chrome.debuggerTabs.add(tab.tabID);
  await assert.rejects(browser.run(command('click', { ref: 'e1' })), /No click was dispatched/);
  assert.deepEqual(
    chrome.debuggerCalls.map((call) => call.action),
    ['attach'],
  );
  assert.equal(chrome.debuggerTabs.has(tab.tabID), true);
});

test('hover-induced target changes are revalidated before pressing and always detach', async () => {
  const { browser, chrome, command } = fixture();
  await browser.run(command('open_tab', { url: 'https://example.com' }));
  await browser.run(command('read_page'));
  const execute = chrome.scripting.executeScript;
  let validations = 0;
  chrome.scripting.executeScript = async (request) => {
    if (request.args?.[0]?.snapshotRevision !== undefined && ++validations === 2)
      throw new Error('Click target moved');
    return execute(request);
  };
  await assert.rejects(browser.run(command('click', { ref: 'e1' })), /moved/);
  assert.deepEqual(
    chrome.debuggerCalls.map((call) => call.params?.type || call.action),
    ['attach', 'mouseMoved', 'detach'],
  );
  assert.equal(chrome.debuggerTabs.size, 0);
});

for (const interrupted of ['cancel', 'disable', 'expire', 'navigate']) {
  test(`${interrupted} during mouse movement prevents the browser press`, async () => {
    const { browser, chrome, command } = fixture();
    const tab = await browser.run(command('open_tab', { url: 'https://example.com' }));
    await browser.run(command('read_page'));
    const pending = command('click', { ref: 'e1' });
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (...args) => {
      await send(...args);
      if (interrupted === 'cancel') await browser.cancel(pending);
      if (interrupted === 'disable') await browser.suspend();
      if (interrupted === 'expire') pending.expiresAt = Date.now() - 1;
      if (interrupted === 'navigate') browser.documents.delete(tab.tabID);
    };
    await assert.rejects(browser.run(pending));
    assert.deepEqual(
      chrome.debuggerCalls.map((call) => call.params?.type || call.action),
      ['attach', 'mouseMoved', 'detach'],
    );
    assert.equal(browser.clickingTabs.size, 0);
  });
}

test('dispatch failure after a press reports an uncertain outcome and detaches without retrying', async () => {
  const { browser, chrome, command } = fixture();
  await browser.run(command('open_tab', { url: 'https://example.com' }));
  await browser.run(command('read_page'));
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => {
    await send(...args);
    if (args[2].type === 'mouseReleased') throw new Error('Target closed');
  };
  await assert.rejects(browser.run(command('click', { ref: 'e1' })), /may already have affected/);
  assert.equal(
    chrome.debuggerCalls.filter((call) => call.params?.type === 'mousePressed').length,
    1,
  );
  assert.equal(chrome.debuggerTabs.size, 0);
});

test('cancellation during attachment detaches without sending mouse input', async () => {
  const { browser, chrome, command } = fixture();
  await browser.run(command('open_tab', { url: 'https://example.com' }));
  await browser.run(command('read_page'));
  const pending = command('click', { ref: 'e1' });
  const attach = chrome.debugger.attach;
  chrome.debugger.attach = async (...args) => {
    await attach(...args);
    await browser.cancel(pending);
  };
  await assert.rejects(browser.run(pending), /cancelled/);
  assert.deepEqual(
    chrome.debuggerCalls.map((call) => call.action),
    ['attach', 'detach'],
  );
});

test('a second click on the same tab cannot interleave browser mouse input', async () => {
  const { browser, chrome, command } = fixture();
  await browser.run(command('open_tab', { url: 'https://example.com' }));
  await browser.run(command('read_page'));
  const moved = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => {
    await send(...args);
    if (args[2].type === 'mouseMoved') {
      moved.resolve();
      await resume.promise;
    }
  };
  const first = browser.run(command('click', { ref: 'e1' }));
  await moved.promise;
  try {
    await assert.rejects(browser.run(command('click', { ref: 'e1' })), /in progress/);
  } finally {
    resume.resolve();
  }
  await first;
  assert.equal(chrome.debuggerCalls.filter((call) => call.action === 'attach').length, 1);
});
