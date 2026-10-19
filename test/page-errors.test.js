import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';

async function fixture(t, frames = false) {
  const chrome = fakeChrome();
  const browser = new SessionBrowser(chrome);
  browser.enabled = true;
  const injectionErrors = [];
  const contexts = new Map(
    (frames ? [0, 7] : [0]).map((id) => {
      const context = {
        documentID: `doc-${id}`,
        framePath: id ? [0] : [],
        viewportWidth: 800,
        viewportHeight: 600,
      };
      const api = {
        setEnabled() {},
        setIndicatorHidden() {},
        run(tool) {
          if (tool === 'read_page') return { ...context, text: '', elements: [{ ref: 'e1' }] };
          if (tool === 'click')
            return {
              clickTarget: { ...context, x: 50, y: 10, snapshotRevision: 1, controlRevision: 0 },
            };
          return { passed: true, ok: true };
        },
        validateClick: () => ({ valid: true }),
        frameContext: () => context,
        projectFramePoint: () => ({ ...context, x: 100, y: 100 }),
      };
      return [id, { api, performance: {} }];
    }),
  );
  chrome.scripting.executeScript = async (request) => {
    if (request.files) return [];
    const ids = request.target.allFrames ? [...contexts.keys()] : request.target.frameIds || [0];
    return Promise.all(
      ids.map(async (frameId) => {
        const context = contexts.get(frameId);
        try {
          const result = await runInNewContext(`(${request.func.toString()})(...args)`, {
            args: request.args || [],
            __opencodeChrome: context.api,
            __opencodePerformance: context.performance,
          });
          return { frameId, result };
        } catch (error) {
          // Mirrors a rejection escaping the injected function into Chrome's uncaught-error reporting.
          injectionErrors.push(error.message);
          throw error;
        }
      }),
    );
  };
  const command = (tool, args = {}) => ({
    tool,
    args,
    sessionID: 'ses_errors',
    generation: browser.bindings.ses_errors?.generation || 'generation',
    expiresAt: Date.now() + 25_000,
  });
  const { tabID } = await browser.run(command('open_tab', { url: 'https://example.com' }));
  await browser.run(command('read_page'));
  t.after(() => browser.suspend());
  return { browser, chrome, contexts, injectionErrors, command, tabID };
}

test('asynchronous page-action refusals propagate to the worker without escaping the injected function', async (t) => {
  const { browser, contexts, injectionErrors, command, chrome } = await fixture(t);
  contexts.get(0).api.run = async () => {
    throw new Error('Page changed before the action.');
  };
  await assert.rejects(
    browser.run(command('type', { ref: 'e1', text: 'demo' })),
    /Page changed before/,
  );
  assert.deepEqual(injectionErrors, []);
  assert.equal(chrome.debuggerCalls.length, 0);
});

test('a target moving after hover still prevents mouse-down and is not an uncaught injection error', async (t) => {
  const { browser, contexts, injectionErrors, command, chrome } = await fixture(t);
  let validations = 0;
  contexts.get(0).api.validateClick = () => {
    if (++validations === 2) throw new Error('Click target moved. Call read_page again.');
    return { valid: true };
  };
  await assert.rejects(browser.run(command('click', { ref: 'e1' })), /Click target moved/);
  assert.deepEqual(injectionErrors, []);
  assert.equal(
    chrome.debuggerCalls.some((call) => call.params?.type === 'mousePressed'),
    false,
  );
  assert.equal(chrome.debuggerTabs.size, 0);
});

for (const method of ['frameContext', 'projectFramePoint']) {
  test(`${method} safety refusals fail closed without uncaught iframe injection errors`, async (t) => {
    const { browser, contexts, injectionErrors, command, chrome } = await fixture(t, true);
    contexts.get(method === 'frameContext' ? 7 : 0).api[method] = () => {
      throw new Error('Containing iframe moved or is covered.');
    };
    await assert.rejects(
      browser.run(command('click', { ref: 'f7:e1' })),
      /Containing iframe moved/,
    );
    assert.deepEqual(injectionErrors, []);
    assert.equal(
      chrome.debuggerCalls.some((call) => call.params?.type === 'mousePressed'),
      false,
    );
  });
}

test('recording condition errors propagate without uncaught injection errors', async (t) => {
  const { browser, contexts, injectionErrors, command, tabID } = await fixture(t);
  contexts.get(0).api.run = () => {
    throw new Error('Invalid condition selector.');
  };
  await assert.rejects(
    browser.recordingInspect(command('start_recording'), tabID, [{ selector: '[' }]),
    /Invalid condition selector/,
  );
  assert.deepEqual(injectionErrors, []);
});

test('performance helper promise failures propagate without uncaught injection errors', async (t) => {
  const { browser, contexts, injectionErrors, tabID } = await fixture(t);
  contexts.get(0).performance.start = async () => {
    throw new Error('Performance capture expired.');
  };
  await assert.rejects(
    browser.inspections.profiles.performance(tabID, 'start', ['id', 1000]),
    /Performance capture expired/,
  );
  assert.deepEqual(injectionErrors, []);
});
