import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerBrowserTools } from '../bridge/tools.js';

test('recording MCP exports only artifact paths and clears memory after successful persistence', async (t) => {
  const requests = [];
  const raw = { video: 'private-video-data', manifest: { task: 'Demo' } };
  const server = new McpServer({ name: 'recording-test', version: 'test' });
  registerBrowserTools(
    server,
    {
      call: async (sessionID, tool, args) => {
        requests.push({ sessionID, tool, args });
        return tool === 'finish_recording' ? raw : { cancelled: true };
      },
    },
    {
      saveRecording: async (output) => {
        assert.equal(output, raw);
        return {
          videoPath: '/private/demo/walkthrough.webm',
          actionsPath: '/private/demo/actions.json',
        };
      },
    },
  );
  const client = new Client({ name: 'test', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  const recordingID = crypto.randomUUID();
  const output = await client.callTool({
    name: 'finish_recording',
    arguments: { recordingID },
    _meta: { 'ai.opencode/sessionID': 'ses_privateRecording' },
  });
  const exported = JSON.parse(output.content[0].text);
  assert.equal(exported.videoPath, '/private/demo/walkthrough.webm');
  assert.equal(JSON.stringify(output).includes('private-video-data'), false);
  assert.deepEqual(
    requests.map((request) => request.tool),
    ['finish_recording', 'cancel_recording'],
  );
  assert.ok(requests.every((request) => request.sessionID === 'ses_privateRecording'));
  assert.equal(requests[1].args.recordingID, recordingID);
});

test('failed recording persistence does not discard retriable browser recording data', async (t) => {
  const calls = [];
  const server = new McpServer({ name: 'recording-test', version: 'test' });
  registerBrowserTools(
    server,
    {
      call: async (_sessionID, tool) => {
        calls.push(tool);
        return {};
      },
    },
    {
      saveRecording: async () => {
        throw new Error('Disk write failed');
      },
    },
  );
  const client = new Client({ name: 'test', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  const output = await client.callTool({
    name: 'finish_recording',
    arguments: { recordingID: crypto.randomUUID() },
    _meta: { 'ai.opencode/sessionID': 'ses_retry' },
  });
  assert.equal(output.isError, true);
  assert.match(output.content[0].text, /Disk write failed/);
  assert.deepEqual(calls, ['finish_recording']);
});
