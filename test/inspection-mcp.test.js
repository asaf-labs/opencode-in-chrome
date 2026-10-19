import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { registerBrowserTools } from '../bridge/tools.js';
import { inspectionToolDefinitions } from '../bridge/inspection-tools.js';

test('inspection schemas require explicit tabs and enforce body and duration bounds', () => {
  const schemas = new Map(
    inspectionToolDefinitions.map(([name, _description, input]) => [
      name,
      z.object(input).strict(),
    ]),
  );
  assert.equal(schemas.get('start_inspection').safeParse({ tabID: 100 }).success, true);
  assert.equal(schemas.get('start_inspection').safeParse({}).success, false);
  assert.equal(
    schemas.get('start_cpu_profile').safeParse({ tabID: 100, durationMs: 60000 }).success,
    false,
  );
  assert.equal(
    schemas
      .get('network_request')
      .safeParse({ tabID: 100, requestID: crypto.randomUUID(), maxBodyChars: 20001 }).success,
    false,
  );
  assert.equal(
    schemas.get('start_inspection').safeParse({ tabID: 100, method: 'Runtime.evaluate' }).success,
    false,
  );
});

test('MCP strips raw CPU/performance captures and preserves session metadata', async (t) => {
  const requests = [],
    server = new McpServer({ name: 'inspection-test', version: 'test' });
  registerBrowserTools(
    server,
    {
      call: async (sessionID, tool, args) => {
        requests.push({ sessionID, tool, args });
        return {
          kind: tool === 'stop_cpu_profile' ? 'cpu-profile' : 'performance-timeline',
          data: { marker: 'raw-profile-data' },
          summary: {},
        };
      },
    },
    {
      saveInspection: async (output) => {
        assert.equal(output.data.marker, 'raw-profile-data');
        return { artifactPath: '/private/local/profile.json', kind: output.kind };
      },
    },
  );
  const client = new Client({ name: 'test', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  for (const name of ['stop_cpu_profile', 'stop_performance_trace']) {
    const output = await client.callTool({
      name,
      arguments: { tabID: 100 },
      _meta: { 'ai.opencode/sessionID': 'ses_inspectionMCP' },
    });
    assert.equal(JSON.stringify(output).includes('raw-profile-data'), false);
    assert.equal(JSON.parse(output.content[0].text).artifactPath, '/private/local/profile.json');
  }
  assert.ok(requests.every((request) => request.sessionID === 'ses_inspectionMCP'));
});
