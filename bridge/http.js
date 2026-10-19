import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { validateBinding } from './hub.js';
import { validateProfile } from './profile-store.js';

export function sameToken(candidate, token) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createBridgeHttp({ token, port = 8790, hub, handleRequest, status = {} }) {
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address()?.port || port}`;
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (req.headers.host !== host || (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) {
      res.writeHead(403).end();
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (!sameToken(req.headers.authorization?.replace(/^Bearer /, ''), token)) {
      res.writeHead(401).end();
      return;
    }
    try {
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (handleRequest && route !== '/status') {
        if (origin) {
          res.writeHead(403).end();
          return;
        }
        if (await handleRequest(req, res, route)) return;
      }
      let output;
      if (req.method === 'GET' && route === '/status') {
        output = {
          ...status,
          connected: !!hub.socket,
          browserEnabled: hub.browserEnabled,
          extensionProtocol: hub.extensionProtocol,
          bindings: Object.fromEntries(hub.bindings),
          activity: hub.activity,
          ...(hub.profilesSnapshot
            ? {
                profiles: hub.profilesSnapshot(),
                features: ['profiles'],
                routingHealthy: !hub.persistenceError,
              }
            : {}),
        };
      } else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(output ?? {}));
    } catch (error) {
      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: error.message }));
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const host = `127.0.0.1:${server.address()?.port || port}`;
    if (
      req.headers.host !== host ||
      req.url !== '/browser' ||
      !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || '')
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      let authenticated = false;
      let connection;
      const deadline = setTimeout(() => ws.close(4003, 'Authentication timeout'), 5000);
      ws.on('close', () => clearTimeout(deadline));
      ws.on('error', () => {});
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (!message || typeof message !== 'object' || Array.isArray(message))
            throw new Error('Invalid message');
          if (!authenticated) {
            if (message.type !== 'hello' || !sameToken(message.token, token)) {
              ws.close(4003, 'Invalid token');
              return;
            }
            const profile = message.version === 3 ? validateProfile(message.profile) : undefined;
            const bindings = [2, 3].includes(message.version)
              ? Object.entries(message.bindings || {})
              : [];
            // Validate the entire handshake before replacing a working connection.
            for (const [sessionID, binding] of bindings) validateBinding(sessionID, binding);
            clearTimeout(deadline);
            authenticated = true;
            connection =
              hub.attach(
                ws,
                [2, 3].includes(message.version) && message.enabled === true,
                message.version || 1,
                profile,
              ) || hub;
            for (const [sessionID, binding] of bindings) connection.bind(sessionID, binding);
            ws.send(JSON.stringify({ type: 'ready', profileID: profile?.id }));
            return;
          }
          if (connection?.socket === ws) connection.receive(message);
        } catch (error) {
          ws.close(
            error.code === 'PROFILE_CONNECTED' ? 4009 : 4002,
            error.code === 'PROFILE_CONNECTED'
              ? 'Profile identity is already connected. Re-pair a fresh extension installation.'
              : 'Invalid message',
          );
        }
      });
    });
  });
  return { server, sockets };
}
