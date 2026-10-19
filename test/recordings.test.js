import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import { recordingToolDefinitions } from '../bridge/recording-tools.js';
import { saveRecordingArtifacts } from '../bridge/recording-artifacts.js';
import { muxWebM } from '../extension/webm.js';

async function fixture() {
  const chrome = fakeChrome();
  const browser = new SessionBrowser(chrome);
  browser.enabled = true;
  const command = (tool, args = {}, sessionID = 'ses_recording') => ({
    tool,
    args,
    id: crypto.randomUUID(),
    sessionID,
    generation: browser.bindings[sessionID]?.generation || 'generation',
    expiresAt: Date.now() + 25000,
  });
  const tab = await browser.run(command('open_tab', { url: 'https://example.com/task' }));
  const plan = {
    tabID: tab.tabID,
    task: 'Select Yes',
    goal: 'The property is Yes',
    steps: [
      {
        id: 'choose-yes',
        description: 'Select the Yes property value',
        before: [{ selector: '#value', text: '--' }],
        actions: [{ tool: 'click', selector: '#yes' }],
        after: [{ selector: '#value', text: 'Yes' }],
      },
    ],
    goalChecks: [{ selector: '#value', text: 'Yes' }],
  };
  return { chrome, browser, command, tab, plan };
}

test('recording plan schemas require observable checks and stable actions before recording', async () => {
  const { plan } = await fixture();
  const start = z.object(recordingToolDefinitions[0][2]).strict();
  assert.equal(start.safeParse(plan).success, true);
  for (const invalid of [
    { ...plan, task: '' },
    { ...plan, goalChecks: [] },
    { ...plan, steps: [plan.steps[0], plan.steps[0]] },
    { ...plan, steps: [{ ...plan.steps[0], after: [] }] },
    { ...plan, steps: [{ ...plan.steps[0], actions: [{ tool: 'click', ref: 'e1' }] }] },
    { ...plan, steps: [{ ...plan.steps[0], actions: [{ tool: 'evaluate', code: 'unsafe' }] }] },
    { ...plan, goalChecks: [{ selector: '#value' }] },
  ])
    assert.equal(start.safeParse(invalid).success, false);
});

test('declared plans are immutable and successful recordings include deterministic actions and goal checks', async () => {
  const { chrome, browser, command, plan } = await fixture();
  const { recordingID } = await browser.run(command('start_recording', plan));
  plan.steps[0].actions[0].selector = '#wrong';
  await assert.rejects(
    browser.run(command('finish_recording', { recordingID })),
    /Every planned step/,
  );
  await assert.rejects(
    browser.run(command('run_recording_step', { recordingID, stepID: 'wrong' })),
    /next step/,
  );
  const result = await browser.run(
    command('run_recording_step', { recordingID, stepID: 'choose-yes' }),
  );
  assert.equal(result.verified, true);
  assert.equal(result.nextStep, null);
  const exported = await browser.run(command('finish_recording', { recordingID }));
  assert.equal(exported.manifest.edited, true);
  assert.equal(exported.manifest.goalVerified, true);
  assert.equal(exported.manifest.steps[0].actions[0].selector, '#yes');
  assert.equal(JSON.stringify(exported.manifest).includes('"ref"'), false);
  assert.equal(exported.manifest.initialURL, 'https://example.com/task');
  assert.equal(
    z
      .object(recordingToolDefinitions[0][2])
      .strict()
      .safeParse({ ...exported.manifest.replayPlan, tabID: 999 }).success,
    true,
  );
  assert.equal(chrome.debuggerCalls.filter((call) => call.action === 'attach').length, 1);
  assert.equal(chrome.debuggerTabs.size, 0);
  assert.ok(chrome.debuggerCalls.some((call) => call.method === 'Page.startScreencast'));
  assert.ok(chrome.debuggerCalls.some((call) => call.method === 'Input.dispatchMouseEvent'));
});

test('failed verification discards captured actions and frames; retry must restore preconditions', async () => {
  const { browser, command, plan } = await fixture();
  const { recordingID } = await browser.run(command('start_recording', plan));
  let baseline = true,
    accepted = false;
  browser.recordingInspect = async (_command, _tabID, checks) => ({
    passed: checks[0].text === '--' ? baseline : accepted,
  });
  const attempt = command('run_recording_step', { recordingID, stepID: 'choose-yes' });
  attempt.expiresAt = Date.now() + 300;
  await assert.rejects(browser.run(attempt), /excluded/);
  const recording = browser.recordings.sessions.get(attempt.sessionID);
  assert.equal(recording.accepted.length, 0);
  assert.equal(recording.bytes, 0);
  assert.equal(browser.recordings.capture.active, null);
  baseline = false;
  await assert.rejects(
    browser.run(command('run_recording_step', { recordingID, stepID: 'choose-yes' })),
    /Restore/,
  );
  baseline = true;
  accepted = true;
  await browser.run(command('run_recording_step', { recordingID, stepID: 'choose-yes' }));
  const exported = await browser.run(command('finish_recording', { recordingID }));
  assert.equal(exported.manifest.omittedAttempts, 2);
  assert.equal(exported.manifest.steps.length, 1);
  assert.deepEqual(exported.manifest.steps[0].actions, [{ tool: 'click', selector: '#yes' }]);
});

test('recordings cannot capture or export another session’s tab or plan', async () => {
  const { browser, command, plan } = await fixture();
  await assert.rejects(
    browser.run(command('start_recording', { ...plan, tabID: 1 })),
    /session-owned/,
  );
  await assert.rejects(browser.run(command('start_recording', plan, 'ses_other')), /session-owned/);
  const { recordingID } = await browser.run(command('start_recording', plan));
  for (const tool of ['run_recording_step', 'finish_recording', 'cancel_recording'])
    await assert.rejects(
      browser.run(command(tool, { recordingID, stepID: 'choose-yes' }, 'ses_other')),
      /not found/,
    );
  assert.equal(browser.recordings.sessions.size, 1);
});

test('suspend cancels capture and clears in-memory recordings without closing owned tabs', async () => {
  const { chrome, browser, command, plan, tab } = await fixture();
  const { recordingID } = await browser.run(command('start_recording', plan));
  browser.recordingAction = async () => browser.suspend();
  await assert.rejects(
    browser.run(command('run_recording_step', { recordingID, stepID: 'choose-yes' })),
    /excluded/,
  );
  assert.equal(browser.recordings.sessions.size, 0);
  assert.equal(browser.recordings.capture.active, null);
  assert.equal(chrome.debuggerTabs.size, 0);
  assert.ok(chrome.tabState.has(tab.tabID));
});

test('a cancelled parent step prevents its nested click before pressing', async () => {
  const { chrome, browser, command, plan } = await fixture();
  const { recordingID } = await browser.run(command('start_recording', plan));
  const pending = command('run_recording_step', { recordingID, stepID: 'choose-yes' });
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (...args) => {
    const result = await send(...args);
    if (args[2]?.type === 'mouseMoved') await browser.cancel(pending);
    return result;
  };
  await assert.rejects(browser.run(pending), /cancelled/);
  assert.equal(
    chrome.debuggerCalls.some((call) => call.params?.type === 'mousePressed'),
    false,
  );
  assert.equal(chrome.debuggerTabs.size, 0);
});

test('suspending during debugger attachment waits for and detaches the eventual attachment', async () => {
  const { chrome, browser, command, plan } = await fixture();
  const { recordingID } = await browser.run(command('start_recording', plan));
  const attaching = Promise.withResolvers(),
    release = Promise.withResolvers();
  const attach = chrome.debugger.attach;
  chrome.debugger.attach = async (...args) => {
    attaching.resolve();
    await release.promise;
    return attach(...args);
  };
  const pending = browser.run(command('run_recording_step', { recordingID, stepID: 'choose-yes' }));
  const rejected = assert.rejects(pending, /excluded/);
  await attaching.promise;
  const stopped = browser.suspend();
  release.resolve();
  await stopped;
  await rejected;
  assert.equal(chrome.debuggerTabs.size, 0);
  assert.equal(browser.recordings.capture.active, null);
  assert.equal(
    chrome.debuggerCalls.some((call) => call.params?.type === 'mousePressed'),
    false,
  );
});

test('closing or protecting a tab clears its recording without touching other owned tabs', async () => {
  for (const protectedPage of [false, true]) {
    const { browser, chrome, command, plan, tab } = await fixture();
    await browser.run(command('start_recording', plan));
    const other = await browser.run(command('open_tab', { url: 'https://example.org' }));
    if (protectedPage)
      await browser.updated(
        tab.tabID,
        { url: 'chrome://settings/' },
        { ...(await chrome.tabs.get(tab.tabID)), url: 'chrome://settings/' },
      );
    else await browser.run(command('close_tab', { tabID: tab.tabID }));
    assert.equal(browser.recordings.sessions.size, 0);
    assert.ok(chrome.tabState.has(other.tabID));
  }
});

test('explicit recording cancellation interrupts a pending attachment without waiting for the session queue', async () => {
  const { chrome, browser, command, plan } = await fixture();
  const { recordingID } = await browser.run(command('start_recording', plan));
  const attaching = Promise.withResolvers(),
    release = Promise.withResolvers();
  const attach = chrome.debugger.attach;
  chrome.debugger.attach = async (...args) => {
    attaching.resolve();
    await release.promise;
    return attach(...args);
  };
  const step = browser.run(command('run_recording_step', { recordingID, stepID: 'choose-yes' }));
  const rejected = assert.rejects(step, /excluded/);
  await attaching.promise;
  const cancelled = browser.run(command('cancel_recording', { recordingID }));
  release.resolve();
  assert.equal((await cancelled).cancelled, true);
  await rejected;
  assert.equal(chrome.debuggerTabs.size, 0);
  assert.equal(browser.recordings.sessions.size, 0);
});

test('pausing a session discards its retained recording plan', async () => {
  const { browser, command, plan } = await fixture();
  await browser.run(command('start_recording', plan));
  await browser.pause('ses_recording');
  assert.equal(browser.recordings.sessions.size, 0);
});

test('recording ignores screencast events from child protocol targets', async () => {
  const { browser, chrome, command, tab } = await fixture();
  const capture = await browser.recordings.capture.start(command('run_recording_step'), tab.tabID);
  const frames = capture.frames.length;
  chrome.emitDebugger(
    tab.tabID,
    'Page.screencastFrame',
    { data: 'cHJpdmF0ZQ==', sessionId: 1 },
    'child',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capture.frames.length, frames);
  assert.equal(
    chrome.debuggerCalls.some((call) => call.method === 'Page.screencastFrameAck'),
    false,
  );
  await browser.recordings.capture.stop();
});

test('goal verification is required at export and explicit cancellation preserves exports', async () => {
  const { browser, command, plan } = await fixture();
  const { recordingID } = await browser.run(command('start_recording', plan));
  await browser.run(command('run_recording_step', { recordingID, stepID: 'choose-yes' }));
  browser.recordingInspect = async () => ({ passed: false });
  await assert.rejects(browser.run(command('finish_recording', { recordingID })), /conditions/);
  const result = await browser.run(command('cancel_recording', { recordingID }));
  assert.equal(result.cancelled, true);
  assert.equal(browser.recordings.sessions.size, 0);
});

test('video muxer is deterministic and writes an EBML WebM container', () => {
  const chunks = [
    { timestamp: 0, key: true, data: Uint8Array.from([1, 2, 3]) },
    { timestamp: 5000000, key: true, data: Uint8Array.from([4, 5, 6]) },
  ];
  const options = { width: 960, height: 540, duration: 6000 };
  const one = muxWebM(chunks, options),
    two = muxWebM(chunks, options);
  assert.deepEqual(one, two);
  assert.deepEqual([...one.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  assert.ok(new TextDecoder().decode(one).includes('V_VP8'));
});

test('recording artifacts stay private, never use provided paths, and return no video bytes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'recording-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = {
    video: 'GkXfow==',
    manifest: {
      schemaVersion: 1,
      kind: 'edited-verified-walkthrough',
      edited: true,
      goalVerified: true,
      task: 'Demo',
      goal: 'Done',
      steps: [{ id: 'first' }],
    },
  };
  const result = await saveRecordingArtifacts(output, { root });
  assert.ok(result.videoPath.startsWith(root + path.sep));
  assert.equal(result.video, undefined);
  assert.equal(JSON.parse(await readFile(result.actionsPath, 'utf8')).task, 'Demo');
  if (process.platform !== 'win32')
    assert.equal((await stat(result.videoPath)).mode & 0o777, 0o600);
  await assert.rejects(
    saveRecordingArtifacts({ ...output, video: 'bm90IHZpZGVv' }, { root }),
    /valid bounded/,
  );
  await assert.rejects(
    saveRecordingArtifacts(
      { ...output, manifest: { ...output.manifest, goalVerified: false } },
      { root },
    ),
  );
});
