import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProfileHub } from './profiles.js';
import { createBridgeHttp } from './http.js';
import { browserToolDefinitions } from './tools.js';

const requestSchema = z
  .object({
    sessionID: z.string().regex(/^ses[\w-]+$/),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

async function readRequest(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 128 * 1024) {
      req.resume();
      throw new Error('Shared browser request is too large.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJSON(res, status, output) {
  if (!res.destroyed)
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(output));
}

export function createSharedBridge(config, { version, hub = new ProfileHub() } = {}) {
  // Process entrypoints inject a file-backed ProfileHub; the default is for embedding/tests.
  const controllers = new Set();
  let close;
  async function handleRequest(req, res, route) {
    if (req.method === 'POST' && route === '/shutdown') {
      writeJSON(res, 200, { stopped: true });
      setImmediate(() => void close());
      return true;
    }
    if (req.method !== 'POST' || route !== '/call') return false;
    const controller = new AbortController();
    controllers.add(controller);
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const request = requestSchema.safeParse(await readRequest(req));
      const definition = request.success
        ? browserToolDefinitions.find(([name]) => name === request.data.tool)
        : undefined;
      const args = definition && z.object(definition[2]).strict().safeParse(request.data.args);
      if (!request.success || !args?.success) {
        writeJSON(res, 400, { error: 'Invalid shared browser request.' });
        return true;
      }
      const result = await hub.call(
        request.data.sessionID,
        request.data.tool,
        args.data,
        controller.signal,
      );
      writeJSON(res, 200, { result });
    } catch (error) {
      writeJSON(res, 400, {
        error: error instanceof SyntaxError ? 'Invalid shared browser request.' : error.message,
      });
    } finally {
      controllers.delete(controller);
    }
    return true;
  }
  const { server, sockets } = createBridgeHttp({
    ...config,
    hub,
    handleRequest,
    status: { mode: 'shared', version, bridgeID: randomUUID() },
  });
  let closing;
  close = () => {
    if (closing) return closing;
    for (const controller of controllers) controller.abort();
    hub.reset('Shared bridge stopped');
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    closing = new Promise((resolve) => server.close(resolve));
    return closing;
  };
  return { server, sockets, hub, close };
}
