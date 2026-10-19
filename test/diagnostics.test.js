import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { inspectBridge, portAvailable } from '../scripts/diagnostics.js';
import { listenBridge } from '../bridge/listen.js';

const config = { token: 'a'.repeat(64), port: 8790 };

test('doctor reports browser readiness without exposing token, bindings, or page data', async () => {
  const checks = await inspectBridge(config, {
    fetchStatus: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${config.token}`);
      return Response.json({
        connected: true,
        browserEnabled: true,
        extensionProtocol: 2,
        bindings: { secret: 'private page data' },
      });
    },
  });
  assert.equal(
    checks.every((check) => check.status === 'pass'),
    true,
  );
  assert.equal(JSON.stringify(checks).includes(config.token), false);
  assert.equal(JSON.stringify(checks).includes('private page data'), false);
});

test('doctor distinguishes free ports, conflicting services, and missing Chrome readiness', async () => {
  const disconnected = await inspectBridge(config, {
    fetchStatus: async () =>
      Response.json({ connected: false, browserEnabled: false, extensionProtocol: null }),
  });
  assert.equal(disconnected[0].status, 'pass');
  assert.equal(disconnected[1].status, 'warn');
  const wrongToken = await inspectBridge(config, {
    fetchStatus: async () => new Response('secret response', { status: 401 }),
  });
  assert.equal(wrongToken[0].status, 'fail');
  assert.equal(JSON.stringify(wrongToken).includes('secret response'), false);
  for (const available of [true, false]) {
    const checks = await inspectBridge(config, {
      fetchStatus: async () => {
        throw new Error(config.token);
      },
      isPortAvailable: async () => available,
    });
    assert.equal(checks[0].status, available ? 'warn' : 'fail');
    assert.equal(JSON.stringify(checks).includes(config.token), false);
  }
});

test('occupied loopback port produces actionable bridge startup guidance', async (t) => {
  const existing = createServer();
  existing.listen(0, '127.0.0.1');
  await once(existing, 'listening');
  t.after(() => new Promise((resolve) => existing.close(resolve)));
  const port = existing.address().port;
  assert.equal(await portAvailable(port), false);
  const second = createServer();
  await assert.rejects(listenBridge(second, port), (error) => {
    assert.equal(error.cause.code, 'EADDRINUSE');
    assert.match(error.message, /Disconnect chrome/);
    assert.match(error.message, /--port/);
    return true;
  });
});

test('doctor distinguishes current multi-profile routing from stale or unwritable bridge state', async () => {
  const status = {
    connected: true,
    browserEnabled: true,
    extensionProtocol: 3,
    version: '0.7.0',
    routingHealthy: true,
    profiles: [{ connected: true, enabled: true, legacy: false }],
  };
  const inspect = (value) =>
    inspectBridge(config, {
      expectedVersion: '0.7.0',
      fetchStatus: async () => Response.json(value),
    });
  assert.equal(
    (await inspect(status)).every((check) => check.status === 'pass'),
    true,
  );
  assert.equal(
    (await inspect({ ...status, version: '0.6.0' })).find((check) => check.id === 'bridge_version')
      .status,
    'warn',
  );
  assert.equal(
    (await inspect({ ...status, routingHealthy: false })).find(
      (check) => check.id === 'profile_routing',
    ).status,
    'fail',
  );
  assert.equal(
    (
      await inspect({ ...status, profiles: [{ connected: true, enabled: true, legacy: true }] })
    ).find((check) => check.id === 'profile_opt_in').status,
    'warn',
  );
});
