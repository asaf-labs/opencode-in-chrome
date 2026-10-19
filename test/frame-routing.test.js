import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrameRef, combineSnapshots } from '../extension/frame-refs.js';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';

test('frame refs distinguish identical local refs and preserve frame metadata', () => {
  assert.deepEqual(parseFrameRef('e1'), { frameID: 0, ref: 'e1' });
  assert.deepEqual(parseFrameRef('f42:e1'), { frameID: 42, ref: 'e1' });
  for (const ref of ['f-1:e1', 'f2:button', 'e1:2', 'f99999999999999999999:e1'])
    assert.throws(() => parseFrameRef(ref));
  const snapshot = combineSnapshots([
    {
      frameId: 42,
      result: {
        documentID: 'child',
        title: 'Iframe',
        text: 'Child content',
        elements: [{ ref: 'e1', label: 'Coupa' }],
      },
    },
    {
      frameId: 0,
      result: {
        documentID: 'main',
        title: 'Main',
        text: 'Root content',
        elements: [{ ref: 'e1', label: 'Portals' }],
      },
    },
  ]);
  assert.deepEqual(
    snapshot.elements.map((element) => element.ref),
    ['e1', 'f42:e1'],
  );
  assert.equal(snapshot.elements[1].frameID, 42);
  assert.match(snapshot.text, /Child content/);
  assert.equal(snapshot.frames.length, 2);
});

async function fixture() {
  const chrome = fakeChrome();
  const browser = new SessionBrowser(chrome);
  browser.enabled = true;
  const command = (tool, args = {}) => ({
    tool,
    args,
    id: crypto.randomUUID(),
    sessionID: 'ses_frames',
    generation: browser.bindings.ses_frames?.generation || 'generation',
    expiresAt: Date.now() + 25000,
  });
  const tab = await browser.run(command('open_tab', { url: 'https://example.com' }));
  const original = chrome.scripting.executeScript;
  let parentDocument = 'root-document';
  chrome.scripting.executeScript = async (request) => {
    if (request.files) return [];
    if (request.func.toString().includes("run('read_page'"))
      return [
        {
          frameId: 0,
          result: { documentID: 'root-document', framePath: [], elements: [{ ref: 'e1' }] },
        },
        {
          frameId: 7,
          result: {
            documentID: 'child-document',
            framePath: [0],
            elements: [{ ref: 'e1', label: 'Coupa' }],
          },
        },
      ].filter(
        (entry) => request.target.allFrames || request.target.frameIds.includes(entry.frameId),
      );
    if (request.func.toString().includes('frameContext'))
      return [
        {
          frameId: 0,
          result: {
            documentID: parentDocument,
            framePath: [],
            viewportWidth: 800,
            viewportHeight: 600,
          },
        },
        {
          frameId: 7,
          result: {
            documentID: 'child-document',
            framePath: [0],
            viewportWidth: 200,
            viewportHeight: 100,
          },
        },
      ];
    if (request.func.toString().includes('projectFramePoint')) {
      assert.deepEqual(request.target.frameIds, [0]);
      assert.equal(request.args[0].documentID, 'root-document');
      return [{ frameId: 0, result: { x: 111, y: 222, viewportWidth: 800, viewportHeight: 600 } }];
    }
    if (request.args?.[0] === 'click')
      return [
        {
          frameId: 7,
          result: {
            clickTarget: {
              x: 10,
              y: 20,
              documentID: 'child-document',
              snapshotRevision: 1,
              controlRevision: 0,
              framePath: [0],
              viewportWidth: 200,
              viewportHeight: 100,
            },
          },
        },
      ];
    if (request.func.toString().includes('validateClick')) {
      assert.deepEqual(request.target.frameIds, [7]);
      assert.equal(request.args[0].ref, 'e1');
      return [{ frameId: 7, result: { valid: true } }];
    }
    if (request.args?.[0] === 'type' || request.args?.[0] === 'scroll') {
      assert.deepEqual(request.target.frameIds, [7]);
      assert.equal(request.args[1].documentID, 'child-document');
      if (request.args[0] === 'type') assert.equal(request.args[1].ref, 'e1');
      return [{ frameId: 7, result: { ok: true } }];
    }
    return original(request);
  };
  await browser.run(command('read_page'));
  return {
    chrome,
    browser,
    command,
    tab,
    changeParent: () => {
      parentDocument = 'new-root-document';
    },
  };
}

test('iframe actions route scoped refs only into their observed owned frame', async () => {
  const { browser, command, tab } = await fixture();
  const typed = await browser.run(command('type', { ref: 'f7:e1', text: 'Coupa' }));
  assert.equal(typed.frameID, 7);
  await browser.run(command('scroll', { frameID: 7, deltaY: 100 }));
  await assert.rejects(
    browser.run(command('type', { tabID: 1, ref: 'f7:e1', text: 'Coupa' })),
    /does not own/,
  );
  await assert.rejects(
    browser.run(command('type', { ref: 'f999:e1', text: 'Coupa' })),
    /latest snapshot/,
  );
  await browser.updated(
    tab.tabID,
    { url: 'https://example.com/new' },
    { ...(await browser.chrome.tabs.get(tab.tabID)), url: 'https://example.com/new' },
  );
  await assert.rejects(
    browser.run(command('type', { ref: 'f7:e1', text: 'Coupa' })),
    /latest snapshot/,
  );
});

test('iframe clicks translate and revalidate the point before dispatching main-viewport mouse input', async () => {
  const { browser, chrome, command } = await fixture();
  const result = await browser.run(command('click', { ref: 'f7:e1' }));
  assert.equal(result.frameID, 7);
  assert.equal(result.dispatched, true);
  for (const call of chrome.debuggerCalls.filter(
    (call) => call.method === 'Input.dispatchMouseEvent',
  )) {
    assert.equal(call.params.x, 111);
    assert.equal(call.params.y, 222);
  }
});

test('an ancestor frame changing during hover prevents mouse-down in the iframe', async () => {
  const { browser, chrome, command, changeParent } = await fixture();
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => {
    const result = await send(...args);
    if (args[2].type === 'mouseMoved') changeParent();
    return result;
  };
  await assert.rejects(browser.run(command('click', { ref: 'f7:e1' })), /Containing frame changed/);
  assert.equal(
    chrome.debuggerCalls.some((call) => call.params?.type === 'mousePressed'),
    false,
  );
  assert.equal(chrome.debuggerCalls.at(-1).action, 'detach');
});
