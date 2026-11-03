import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runtimeRevision } from './runtime-revision.js';

async function launchAdapter() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL('./shared-adapter.js', import.meta.url)),
      ...process.argv.slice(2),
    ],
    stderr: 'inherit',
  });
  const client = new Client({ name: 'chrome-update-supervisor', version: '1' });
  try {
    await client.connect(transport);
    await client.listTools();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export class RefreshingAdapter {
  active = 0;
  queue = Promise.resolve();
  current = null;
  closed = false;
  constructor({ revision = runtimeRevision, launch = launchAdapter, changed = () => {} } = {}) {
    this.revision = revision;
    this.launch = launch;
    this.changed = changed;
  }

  async use(work, signal) {
    const select = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.closed || signal?.aborted) throw new Error('Browser request cancelled.');
        const { revision } = await this.revision();
        if (!this.current || (this.current.revision !== revision && !this.active)) {
          const client = await this.launch();
          if (
            this.current &&
            client.getServerCapabilities?.()?.experimental?.chromeUpdate?.deferred
          ) {
            await client.close();
            this.active++;
            return this.current.client;
          }
          try {
            if (this.closed || (await this.revision()).revision !== revision)
              throw new Error(
                'Installation changed while loading the browser adapter; no action was dispatched.',
              );
          } catch (error) {
            await client.close();
            throw error;
          }
          const old = this.current;
          this.current = { client, revision };
          if (old) {
            await old.client.close();
            await this.changed();
          }
        }
        this.active++;
        return this.current.client;
      });
    this.queue = select;
    const client = await select;
    try {
      if (signal?.aborted) throw new Error('Browser request cancelled.');
      return await work(client);
    } finally {
      this.active--;
    }
  }

  async close() {
    this.closed = true;
    await this.queue.catch(() => {});
    await this.current?.client.close();
  }
}
