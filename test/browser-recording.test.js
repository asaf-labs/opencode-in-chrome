import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import { startTestBrowser } from './cdp-browser.js';
import { saveRecordingArtifacts } from '../bridge/recording-artifacts.js';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const modules = new Map(
  await Promise.all(
    ['video-encoder.js', 'webm.js'].map(async (name) => [
      '/' + name,
      await readFile(new URL('../extension/' + name, import.meta.url), 'utf8'),
    ]),
  ),
);
const html = `<!doctype html><title>Predetermined recording task</title>
<style>button { margin: 100px; width: 100px; height: 40px; }</style>
<h1>Set the property to Yes</h1><div id="value">--</div><button id="yes">Yes</button>
<script>window.rejectSelection = true;
document.getElementById('yes').addEventListener('click', (event) => {
  if (event.isTrusted && !rejectSelection) document.getElementById('value').textContent = 'Yes';
});</script>`;

test(
  'real Chrome exports playable video and deterministic actions with a failed attempt excluded',
  {
    skip: !process.env.CHROME_BINARY && 'Set CHROME_BINARY for the isolated recording regression.',
    timeout: 30000,
  },
  async (t) => {
    const server = createServer((req, res) => {
      res
        .writeHead(200, { 'Content-Type': modules.has(req.url) ? 'text/javascript' : 'text/html' })
        .end(
          modules.get(req.url) ||
            (req.url === '/done'
              ? '<!doctype html><title>Goal reached</title><h1 id="goal">Done</h1>'
              : html),
        );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const cdp = await startTestBrowser(t);
    const url = `http://127.0.0.1:${server.address().port}`;
    await cdp.navigate(url);
    const chrome = fakeChrome();
    const browser = new SessionBrowser(chrome);
    browser.enabled = true;
    const update = chrome.tabs.update;
    chrome.tabs.update = async (tabID, changes) => {
      const tab = await update(tabID, changes);
      if (changes.url) await cdp.navigate(changes.url);
      return tab;
    };
    const listeners = new Set();
    chrome.debugger.onEvent = {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    };
    cdp.onEvent('Page.screencastFrame', (params) => {
      for (const listener of listeners) listener({ tabId: 100 }, 'Page.screencastFrame', params);
    });
    chrome.scripting.executeScript = async (request) => {
      const contextID = await cdp.context();
      if (request.files) {
        await cdp.evaluate(content, contextID);
        return [];
      }
      return [
        {
          result: await cdp.evaluate(
            `(${request.func.toString()})(...${JSON.stringify(request.args || [])})`,
            contextID,
          ),
        },
      ];
    };
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (target, method, params) => {
      await send(target, method, params);
      return cdp.command(method, params);
    };
    chrome.runtime.sendMessage = ({ segments }) =>
      cdp.evaluate(
        `import('${url}/video-encoder.js').then(({encodeWalkthrough}) => encodeWalkthrough(${JSON.stringify(segments)}))`,
      );
    const command = (tool, args = {}) => ({
      tool,
      args,
      id: crypto.randomUUID(),
      sessionID: 'ses_videoTest',
      generation: browser.bindings.ses_videoTest?.generation || 'generation',
      expiresAt: Date.now() + 25000,
    });
    const tab = await browser.run(command('open_tab', { url }));
    const plan = {
      tabID: tab.tabID,
      task: 'Choose Yes',
      goal: 'Choose Yes, then reach the Done page',
      steps: [
        {
          id: 'choose-yes',
          description: 'Select Yes using the property button',
          before: [{ selector: '#value', text: '--' }],
          actions: [{ tool: 'click', selector: '#yes' }],
          after: [{ selector: '#value', text: 'Yes' }],
        },
        {
          id: 'reach-goal',
          description: 'Navigate to the declared Done page',
          before: [{ selector: '#value', text: 'Yes' }],
          actions: [{ tool: 'navigate', url: url + '/done' }],
          after: [{ selector: '#goal', text: 'Done' }],
        },
      ],
      goalChecks: [{ url: url + '/done' }, { selector: '#goal', text: 'Done' }],
    };
    const { recordingID } = await browser.run(command('start_recording', plan));
    const rejected = command('run_recording_step', { recordingID, stepID: 'choose-yes' });
    rejected.expiresAt = Date.now() + 3000;
    await assert.rejects(browser.run(rejected), /excluded/);
    assert.equal(browser.recordings.sessions.get('ses_videoTest').accepted.length, 0);
    await cdp.evaluate('rejectSelection = false');
    await browser.run(command('run_recording_step', { recordingID, stepID: 'choose-yes' }));
    await browser.run(command('run_recording_step', { recordingID, stepID: 'reach-goal' }));
    const exported = await browser.run(command('finish_recording', { recordingID }));
    assert.equal(exported.manifest.omittedAttempts, 1);
    assert.equal(exported.manifest.steps.length, 2);
    assert.deepEqual(exported.manifest.steps[0].actions, [{ tool: 'click', selector: '#yes' }]);
    assert.equal(exported.manifest.goalVerified, true);
    assert.equal(chrome.debuggerTabs.size, 0);
    const media = await cdp.evaluate(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(exported.video)}), character => character.charCodeAt(0));
    const video = document.createElement('video');
    const loaded = new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('Invalid video')); });
    video.src = URL.createObjectURL(new Blob([bytes], {type:'video/webm'})); document.body.append(video);
    await loaded;
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
  })()`);
    assert.equal(media.width, 960);
    assert.equal(media.height, 540);
    assert.ok(media.duration >= 2 && media.duration < 8);
    assert.equal(exported.manifest.steps[1].video.startMs, exported.manifest.steps[0].video.endMs);
    if (process.env.SAVE_RECORDING_DEMO === '1') {
      const artifacts = await saveRecordingArtifacts(exported);
      t.diagnostic('Demo artifacts: ' + JSON.stringify(artifacts));
    }
  },
);
