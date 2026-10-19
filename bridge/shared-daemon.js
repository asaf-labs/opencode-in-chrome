import { readFile } from 'node:fs/promises';
import { readConfig } from './config.js';
import { sharedConfigURL } from './shared-config.js';
import { createSharedBridge } from './shared-server.js';
import { listenBridge } from './listen.js';
import { createProfileHub } from './profiles.js';

try {
  const configURL = sharedConfigURL();
  const config = await readConfig(configURL);
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const hub = await createProfileHub(new URL('./profile-routing.json', configURL));
  const bridge = createSharedBridge(config, { version, hub });
  await listenBridge(bridge.server, config.port);
  process.on('SIGINT', () => void bridge.close());
  process.on('SIGTERM', () => void bridge.close());
} catch (error) {
  console.error(`Shared Chrome bridge failed: ${error.message}`);
  process.exitCode = 1;
}
