import { createServer } from 'node:net';
import { readConfig } from '../bridge/config.js';

export async function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export async function inspectBridge(
  config,
  { fetchStatus = fetch, isPortAvailable = portAvailable, expectedVersion } = {},
) {
  const checks = [];
  const check = (id, status, message) => checks.push({ id, status, message });
  const base = `http://127.0.0.1:${config.port}`;
  try {
    const response = await fetchStatus(`${base}/status`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (response.status !== 200) {
      check(
        'bridge',
        'fail',
        `Port ${config.port} answered with HTTP ${response.status}. Another service or a bridge with different pairing settings may be using it. Disconnect the old bridge before reconnecting.`,
      );
      return checks;
    }
    const status = await response.json();
    if (
      typeof status.connected !== 'boolean' ||
      typeof status.browserEnabled !== 'boolean' ||
      !('extensionProtocol' in status)
    ) {
      check('bridge', 'fail', 'The status response is not a recognized Chrome bridge response.');
      return checks;
    }
    check(
      'bridge',
      'pass',
      status.mode === 'shared'
        ? `Authenticated shared bridge reachable at ${base}; serves all configured projects.`
        : `Authenticated bridge reachable at ${base}.`,
    );
    if (expectedVersion)
      check(
        'bridge_version',
        status.version === expectedVersion ? 'pass' : 'warn',
        status.version === expectedVersion
          ? `Running bridge version ${expectedVersion}.`
          : `Running bridge version ${status.version || 'unknown'}; checkout is ${expectedVersion}. Restart the updated bridge and reconnect MCP adapters.`,
      );
    check(
      'browser',
      status.connected && [2, 3].includes(status.extensionProtocol) ? 'pass' : 'warn',
      status.connected && [2, 3].includes(status.extensionProtocol)
        ? `Chrome extension is connected using protocol ${status.extensionProtocol}.`
        : 'Chrome is disconnected or uses an old extension. Load/reload extension/ and pair it using npm run pair.',
    );
    check(
      'enabled',
      status.connected && status.browserEnabled ? 'pass' : 'warn',
      status.connected && status.browserEnabled
        ? 'Browser access is enabled.'
        : 'Open the extension popup and choose Save & enable browser.',
    );
    if (Array.isArray(status.profiles)) {
      if (status.routingHealthy === false)
        check(
          'profile_routing',
          'fail',
          'Profile routing could not be saved. Repair access to .local/profile-routing.json; no actions are sent until routing can be persisted.',
        );
      const connected = status.profiles.filter((profile) => profile.connected).length;
      const enabled = status.profiles.filter((profile) => profile.enabled).length;
      check(
        'profiles',
        enabled ? 'pass' : 'warn',
        `${status.profiles.length} registered profile(s), ${connected} connected, ${enabled} enabled. Use list_profiles and select_profile to choose an account/profile; disconnected selections never fall back.`,
      );
      if (status.profiles.some((profile) => profile.connected && profile.legacy)) {
        check(
          'profile_opt_in',
          'warn',
          'A legacy extension is connected. Reload the extension in that Chrome profile, name it, and Save & enable browser for multi-profile opt-in.',
        );
      }
    }
  } catch {
    // Never print response bodies, credentials, binding URLs, or raw network errors.
    const available = await isPortAvailable(config.port).catch(() => false);
    check(
      'bridge',
      available ? 'warn' : 'fail',
      available
        ? `Port ${config.port} is free; no bridge is running. Connect chrome in the target project's /mcps interface.`
        : `Port ${config.port} is occupied but the authenticated bridge is unreachable. Identify its owner and disconnect an old bridge, or choose a free port.`,
    );
  }
  return checks;
}

export async function diagnose({
  configPath,
  nodeVersion = process.versions.node,
  resolveDependency,
  ...options
} = {}) {
  const checks = [
    {
      id: 'node',
      status: Number(nodeVersion.split('.')[0]) >= 24 ? 'pass' : 'fail',
      message: `Node.js ${nodeVersion}; requires 24+.`,
    },
  ];
  if (resolveDependency) {
    try {
      for (const name of ['@modelcontextprotocol/sdk/server/mcp.js', 'ws', 'zod'])
        resolveDependency(name);
      checks.push({
        id: 'dependencies',
        status: 'pass',
        message: 'Runtime dependencies are installed.',
      });
    } catch {
      checks.push({
        id: 'dependencies',
        status: 'fail',
        message: 'Dependencies are missing. Run npm ci from the extension repository.',
      });
    }
  }
  let config;
  try {
    config = await readConfig(configPath);
  } catch (error) {
    checks.push({
      id: 'config',
      status: 'fail',
      message:
        error.code === 'ENOENT'
          ? 'Pairing settings are missing. Run npm run install:opencode -- --project <target-project>.'
          : 'Pairing settings are invalid or unreadable. Inspect .local/config.json locally; do not share its token.',
    });
    return { ready: false, checks };
  }
  checks.push({
    id: 'config',
    status: 'pass',
    message: `Pairing settings are valid; port ${config.port}. Token is hidden.`,
  });
  checks.push(...(await inspectBridge(config, options)));
  return { ready: checks.every((check) => check.status === 'pass'), checks };
}
