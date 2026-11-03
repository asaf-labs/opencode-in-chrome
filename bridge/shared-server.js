import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ProfileHub } from './profiles.js';
import { createBridgeHttp } from './http.js';
import { browserToolDefinitions } from './tools.js';
import { runtimeRevision } from './runtime-revision.js';

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

export function createSharedBridge(
  config,
  { version, hub = new ProfileHub(), runtime, readRevision = runtimeRevision } = {},
) {
  // Process entrypoints inject a file-backed ProfileHub; the default is for embedding/tests.
  const controllers = new Set();
  let close;
  let updating = false;
  const bridgeID = randomUUID();
  async function handleRequest(req, res, route) {
    if (req.method === 'POST' && route === '/activate') {
      const input = z
        .object({
          bridgeID: z.string().uuid(),
          installation: z.string().regex(/^[a-f0-9]{64}$/),
          revision: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(await readRequest(req));
      if (!runtime || input.bridgeID !== bridgeID || input.installation !== runtime.installation) {
        writeJSON(res, 409, { error: 'Automatic update target does not match this installation.' });
        return true;
      }
      if (updating || controllers.size || hub.pending.size || hub.inFlight.size) {
        writeJSON(res, 200, { activated: false, deferred: true, updating });
        return true;
      }
      updating = true;
      const id = randomUUID();
      const profiles = [...hub.profiles.values()].filter(
        (profile) => profile.hub.socket?.readyState === 1,
      );
      let committed = false;
      try {
        const target = await readRevision();
        if (target.installation !== input.installation || target.revision !== input.revision)
          throw new Error(
            'Installation changed during activation; no browser action was dispatched.',
          );
        const prepared = await Promise.allSettled(
          profiles.map(async (profile) => {
            const result = await profile.hub.update('prepare', id, target.extensionRevision);
            if (result?.prepared !== true)
              throw new Error('Extension did not confirm update readiness.');
          }),
        );
        const refused = prepared.find((result) => result.status === 'rejected');
        if (refused) throw refused.reason;
        await hub.flush();
        const current = await readRevision();
        if (current.revision !== target.revision)
          throw new Error('Installation changed during activation.');
        const commits = await Promise.allSettled(
          profiles.map(async (profile) => {
            const result = await profile.hub.update('commit', id, target.extensionRevision);
            if (result?.committed !== true)
              throw new Error('Extension did not confirm activation.');
          }),
        );
        const failed = commits.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
        committed = true;
        writeJSON(res, 200, { activated: true, profiles: profiles.map((profile) => profile.id) });
        setImmediate(() => void close());
      } catch (error) {
        await Promise.allSettled(profiles.map((profile) => profile.hub.update('release', id)));
        writeJSON(res, 200, { activated: false, deferred: true, reason: error.message });
      } finally {
        if (!committed) updating = false;
      }
      return true;
    }
    if (req.method === 'POST' && route === '/shutdown') {
      writeJSON(res, 200, { stopped: true });
      setImmediate(() => void close());
      return true;
    }
    if (req.method !== 'POST' || route !== '/call') return false;
    if (updating) {
      writeJSON(res, 409, {
        error:
          'Browser update is activating. No action was dispatched; try again after reconnection.',
      });
      return true;
    }
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
    acceptingConnections: () => !updating,
    status: {
      mode: 'shared',
      version,
      bridgeID,
      runtime,
      updateProtocol: runtime ? 1 : undefined,
      get updating() {
        return updating;
      },
    },
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
