import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RefreshingAdapter } from './refreshing-adapter.js';

try {
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const mcp = new Server(
    { name: 'opencode-in-chrome', version },
    { capabilities: { tools: { listChanged: true } } },
  );
  const adapter = new RefreshingAdapter({ changed: () => mcp.sendToolListChanged() });
  mcp.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
    adapter.use(
      (client) => client.listTools(request.params, { signal: extra.signal }),
      extra.signal,
    ),
  );
  mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await adapter.use(
        (client) => client.callTool(request.params, undefined, { signal: extra.signal }),
        extra.signal,
      );
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  await mcp.connect(new StdioServerTransport());
  const shutdown = () =>
    void adapter
      .close()
      .finally(() => mcp.close())
      .finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
} catch (error) {
  console.error(`Global Chrome MCP failed: ${error.message}`);
  process.exitCode = 1;
}
