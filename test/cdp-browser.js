import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

export async function startTestBrowser(t) {
  const profile = await mkdtemp(path.join(tmpdir(), 'chrome-input-test-'));
  const child = spawn(
    process.env.CHROME_BINARY,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let socket;
  t.after(async () => {
    socket?.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `Test Chrome did not start. Startup diagnostics: ${output.slice(-2000) || 'no stderr output'}`,
          ),
        ),
      20000,
    );
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Test Chrome exited before starting.')));
    child.stderr.on('data', (chunk) => {
      output = (output + chunk).slice(-10000);
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  const events = new EventEmitter();
  const pending = new Map();
  let nextID = 0;
  socket.on('message', (data) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else {
      events.emit(message.method, message);
      events.emit('protocol', message);
    }
  });
  socket.on('close', () => {
    for (const request of pending.values()) request.reject(new Error('Test Chrome disconnected.'));
    pending.clear();
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Test Chrome disconnected.'));
        return;
      }
      const id = ++nextID;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression, contextId) => {
    const result = await command('Runtime.evaluate', {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      );
    return result.result.value;
  };
  await command('Page.enable');
  const frameIDs = new Map();
  return {
    command,
    evaluate,
    context: async () => {
      const { frameTree } = await command('Page.getFrameTree');
      const { executionContextId } = await command('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'opencode-test',
      });
      return executionContextId;
    },
    onEvent: (method, callback) =>
      events.on(method, (message) => {
        if (message.sessionId === sessionId) callback(message.params);
      }),
    onAnyEvent: (callback) =>
      events.on('protocol', (message) => {
        if (message.sessionId === sessionId) callback(message.method, message.params);
      }),
    contexts: async () => {
      const { frameTree } = await command('Page.getFrameTree');
      const frames = [];
      const collect = (tree) => {
        frames.push(tree.frame);
        for (const child of tree.childFrames || []) collect(child);
      };
      collect(frameTree);
      const result = [];
      for (const frame of frames) {
        if (!frameIDs.has(frame.id)) frameIDs.set(frame.id, frameIDs.size);
        const { executionContextId } = await command('Page.createIsolatedWorld', {
          frameId: frame.id,
          worldName: 'opencode-test',
        });
        result.push({ frameId: frameIDs.get(frame.id), contextID: executionContextId });
      }
      return result;
    },
    navigate: async (url) => {
      const loaded = once(events, 'Page.loadEventFired');
      const result = await command('Page.navigate', { url });
      if (result.errorText) throw new Error(result.errorText);
      await loaded;
      const { frameTree } = await command('Page.getFrameTree');
      const { executionContextId } = await command('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'opencode-test',
      });
      return executionContextId;
    },
  };
}
