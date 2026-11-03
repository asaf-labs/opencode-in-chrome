import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from './config.js';
import { sharedConfigURL } from './shared-config.js';
import { ensureSharedDaemon } from './shared-process.js';
import { SharedBrowserHub } from './shared-client.js';
import { registerBrowserTools } from './tools.js';

try {
  const configURL = sharedConfigURL();
  const config = await readConfig(configURL);
  const status = await ensureSharedDaemon(config, { configURL });
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const mcp = new McpServer(
    { name: 'opencode-in-chrome', version },
    {
      capabilities: { experimental: { chromeUpdate: { deferred: !!status.updateDeferred } } },
    },
  );
  registerBrowserTools(mcp, new SharedBrowserHub(config, { configURL }));
  await mcp.connect(new StdioServerTransport());
  const shutdown = () => void mcp.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
} catch (error) {
  console.error(`Global Chrome adapter failed: ${error.message}`);
  process.exitCode = 1;
}
