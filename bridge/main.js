import { readConfig } from './config.js';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProfileHub } from './profiles.js';
import { createBridgeHttp } from './http.js';
import { registerBrowserTools } from './tools.js';
import { listenBridge } from './listen.js';

const config = await readConfig().catch((error) => {
  if (error.code === 'ENOENT') throw new Error('Run npm run setup in opencode-in-chrome first.');
  throw error;
});
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const hub = await createProfileHub(new URL('../.local/profile-routing.json', import.meta.url));
const { server, sockets } = createBridgeHttp({ ...config, hub, status: { version } });
try {
  await listenBridge(server, config.port);
} catch (error) {
  console.error(`OpenCode Chrome bridge: ${error.message}`);
  process.exit(1);
}
// Only protocol messages go to stdout; OpenCode owns this process via stdio.
console.error(`OpenCode Chrome bridge listening on http://127.0.0.1:${config.port}`);
const mcp = new McpServer({ name: 'opencode-in-chrome', version });
registerBrowserTools(mcp, hub);
await mcp.connect(new StdioServerTransport());
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  hub.reset('Bridge stopped');
  for (const ws of sockets.clients) ws.terminate();
  server.close();
  void mcp.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
